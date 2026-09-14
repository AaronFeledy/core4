import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { AbsolutePath, type AppPlan, ProviderId, type ScanPlan, ServiceName } from "@lando/sdk/schema";

import * as liveModule from "../../../src/subsystems/scanner/live.ts";
import { appId, drive, endpointsOf, httpStatus, publishedEndpoint, requestSequence } from "./support.ts";

const { makeUrlScanner } = liveModule;

const web = ServiceName.make("web");
const db = ServiceName.make("db");

const planWithScanner = (scanner: ScanPlan): AppPlan => ({
  id: appId,
  name: "myapp",
  slug: "myapp",
  root: AbsolutePath.make("/tmp/myapp"),
  provider: ProviderId.make("test"),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake(0), source: "test", runtime: 4 },
  extensions: {},
  services: {
    [web]: {
      name: web,
      type: "web",
      provider: ProviderId.make("test"),
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: { resolvedAt: DateTime.unsafeMake(0), source: "test", runtime: 4 },
      extensions: {},
      scanner,
    },
  },
});

describe("makeUrlScanner", () => {
  test("plan path and okCodes override defaults for that service only", async () => {
    // Given two HTTP services, only one with resolved scan settings.
    const http = requestSequence([httpStatus(418)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080), publishedEndpoint(db, "http", 8081)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 1, path: "/default", okCodes: [404] },
    );
    const plan = planWithScanner({
      enabled: true,
      path: "/ready",
      okCodes: [418],
      retries: 0,
      timeoutMs: 1000,
    });
    // When scanning the plan.
    const result = await drive(scanner.scan(appId, { plan }));
    // Then overrides do not leak to the service absent from the plan.
    expect(result.endpoints.map(({ url, outcome }) => ({ url, outcome }))).toEqual([
      { url: "http://localhost:8080/ready", outcome: "green" },
      { url: "http://localhost:8081/default", outcome: "yellow" },
    ]);
    expect(http.requests.map(({ url }) => url)).toEqual(result.endpoints.map(({ url }) => url));
  });

  test("plan-disabled service is skipped entirely", async () => {
    // Given a disabled service alongside an unconfigured service.
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080), publishedEndpoint(db, "http", 8081)]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });
    const plan = planWithScanner({
      enabled: false,
      path: "/ready",
      okCodes: [],
      retries: 0,
      timeoutMs: 1000,
    });
    // When scanning the plan.
    const result = await drive(scanner.scan(appId, { plan }));
    // Then the disabled service produces neither requests nor results.
    expect(http.requests.map(({ url }) => url)).toEqual(["http://localhost:8081/"]);
    expect(result.endpoints.map(({ service }) => service)).toEqual([db]);
  });

  test("scan without options keeps app-wide settings", async () => {
    // Given app-wide non-default settings and two services.
    const http = requestSequence([httpStatus(418)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080), publishedEndpoint(db, "http", 8081)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { retry: 1, path: "/global", okCodes: [418] },
    );
    // When no plan is supplied.
    const result = await drive(scanner.scan(appId));
    // Then both services use the same settings.
    expect(result.endpoints.map(({ url, outcome }) => ({ url, outcome }))).toEqual([
      { url: "http://localhost:8080/global", outcome: "green" },
      { url: "http://localhost:8081/global", outcome: "green" },
    ]);
  });

  test("scans http endpoints through the HttpClient chokepoint and resolves green", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });

    expect(scanner.id).toBe("http-probe");

    const result = await drive(scanner.scan(appId));

    expect(result).toEqual({
      appId,
      endpoints: [
        {
          service: web,
          url: "http://localhost:8080/",
          reachable: true,
          statusCode: 200,
          outcome: "green",
        },
      ],
    });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe("GET");
    expect(http.requests[0]?.timeoutMs).toBe(5_000);
    expect(http.requests[0]?.redirect).toBe("manual");
    expect(http.requests[0]?.callerId).toBe("url-scanner");
  });

  test("maxRedirects and path map onto the outbound request", async () => {
    const http = requestSequence([httpStatus(204)]);
    const source = endpointsOf([publishedEndpoint(web, "https", 8443)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { maxRedirects: 3, path: "/healthz", timeoutSeconds: 2 },
    );

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints[0]?.url).toBe("https://localhost:8443/healthz");
    expect(result.endpoints[0]?.outcome).toBe("green");
    expect(http.requests[0]?.redirect).toBe("follow");
    expect(http.requests[0]?.timeoutMs).toBe(2_000);
  });

  test("skips published non-http endpoints", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(db, "tcp", 5432), publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(http.requests).toHaveLength(1);
  });

  test("supplied urls are probed without listing provider endpoints", async () => {
    // Given: start already knows the host-facing URLs, including router authorities.
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });
    const plan = planWithScanner({
      enabled: true,
      path: "/ready",
      okCodes: [],
      retries: 0,
      timeoutMs: 1000,
    });

    // When
    const result = await drive(
      scanner.scan(appId, {
        plan,
        urls: [{ service: web, url: "https://web.demo.lndo.site:4443/ready" }],
      }),
    );

    // Then: the captured provider is not consulted.
    expect(source.calls).toHaveLength(0);
    expect(result.endpoints.map(({ url, outcome }) => ({ url, outcome }))).toEqual([
      { url: "https://web.demo.lndo.site:4443/ready", outcome: "green" },
    ]);
    expect(http.requests.map(({ url }) => url)).toEqual(["https://web.demo.lndo.site:4443/ready"]);
  });

  test("enabled false short-circuits without probing", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([publishedEndpoint(web, "http", 8080)]);
    const scanner = makeUrlScanner(
      { request: http.request, listEndpoints: source.listEndpoints },
      { enabled: false },
    );

    const result = await drive(scanner.scan(appId));

    expect(result).toEqual({ appId, endpoints: [] });
    expect(source.calls).toHaveLength(0);
    expect(http.requests).toHaveLength(0);
  });
});
