import { describe, expect, test } from "bun:test";

import { ServiceName } from "@lando/sdk/schema";

import * as liveModule from "../../../src/subsystems/scanner/live.ts";
import { appId, drive, endpointsOf, httpStatus, requestSequence } from "./support.ts";

const { makeUrlScanner } = liveModule;

const web = ServiceName.make("web");
const worker = ServiceName.make("worker");
const db = ServiceName.make("db");

describe("makeUrlScanner", () => {
  test("scans http endpoints through the HttpClient chokepoint and resolves green", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
    const source = endpointsOf([{ service: web, protocol: "https", port: 8443 }]);
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

  test("skips non-http and port-less endpoints", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([
      { service: db, protocol: "tcp", port: 5432 },
      { service: worker, protocol: "unix" },
      { service: web, protocol: "http", port: 8080 },
    ]);
    const scanner = makeUrlScanner({ request: http.request, listEndpoints: source.listEndpoints });

    const result = await drive(scanner.scan(appId));

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.service).toBe(web);
    expect(http.requests).toHaveLength(1);
  });

  test("enabled false short-circuits without probing", async () => {
    const http = requestSequence([httpStatus(200)]);
    const source = endpointsOf([{ service: web, protocol: "http", port: 8080 }]);
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
