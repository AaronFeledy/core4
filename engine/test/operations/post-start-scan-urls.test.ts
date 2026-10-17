import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";
import type { UrlScannerShape } from "@lando/sdk/services";

import { runPostStartScan, startupScanUrls } from "../../src/operations/post-start-scan.ts";
import { plan, web } from "./start-progress-topology-support.ts";

describe("startupScanUrls", () => {
  test.each(["tcp", "udp", "redis", "valkey", "postgresql", "memcached"])(
    "excludes %s endpoints while retaining HTTP and HTTPS targets",
    (protocol) => {
      const urls = startupScanUrls(plan, [
        {
          name: "web",
          endpoints: [`${protocol}://localhost:16379`, "http://localhost:8080", "https://localhost:8443"],
        },
      ]);
      expect(urls).toEqual([
        { service: web.name, url: "http://localhost:8080/" },
        { service: web.name, url: "https://localhost:8443/" },
      ]);
    },
  );

  test.each([
    "http://*.wild.demo.lndo.site:8000",
    "https://wild.*.demo.lndo.site:4443",
    "http://web*.demo.lndo.site:8000/prefix",
    "https://%2A.demo.lndo.site",
  ])("skips wildcard hostname %s while keeping exact routes and provider endpoints", (wildcard) => {
    const services = [
      { name: "web", endpoints: [wildcard, "https://web.demo.lndo.site", "http://localhost:8080"] },
    ];
    const urls = startupScanUrls(plan, services);
    expect(urls).toEqual([
      { service: web.name, url: "https://web.demo.lndo.site/" },
      { service: web.name, url: "http://localhost:8080/" },
    ]);
    expect(services[0]?.endpoints).toEqual([wildcard, "https://web.demo.lndo.site", "http://localhost:8080"]);
  });

  test("keeps an exact hostname when its path contains an asterisk", () => {
    const urls = startupScanUrls(plan, [{ name: "web", endpoints: ["https://web.demo.lndo.site/files/*"] }]);
    expect(urls).toEqual([{ service: web.name, url: "https://web.demo.lndo.site/files/*/" }]);
  });

  test("does not probe or publish a tree when every displayed hostname is a wildcard", async () => {
    let calls = 0;
    const scanner: UrlScannerShape = {
      id: "stub",
      scan: () =>
        Effect.sync(() => {
          calls++;
          return { appId: plan.id, endpoints: [] };
        }),
      detectCollisions: () => Effect.succeed([]),
    };
    const urls = startupScanUrls(plan, [{ name: "web", endpoints: ["http://*.demo.lndo.site:8000"] }]);
    await Effect.runPromise(
      runPostStartScan({
        scanner,
        plan,
        urls,
        events: {
          publish: () =>
            Effect.sync(() => {
              calls++;
            }),
        },
      }),
    );
    expect(calls).toBe(0);
  });

  test("joins scanner paths onto published and routed bases", () => {
    const scan = { enabled: true, path: "/ready", okCodes: [], retries: 0, timeoutMs: 1000 };
    const urls = startupScanUrls(
      {
        ...plan,
        services: {
          [web.name]: { ...web, scanner: scan },
          [ServiceName.make("api")]: {
            ...web,
            name: ServiceName.make("api"),
            scanner: { ...scan, path: "/" },
          },
        },
      },
      [
        { name: "web", endpoints: ["http://localhost:8080", "https://web.demo.lndo.site:4443"] },
        { name: "api", endpoints: ["https://web.demo.lndo.site/api"] },
      ],
    );
    expect(urls.map((row) => row.url)).toEqual([
      "http://localhost:8080/ready",
      "https://web.demo.lndo.site:4443/ready",
      "https://web.demo.lndo.site/api/",
    ]);
  });
});
