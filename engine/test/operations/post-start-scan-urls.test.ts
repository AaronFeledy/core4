import { expect, test } from "bun:test";
import { type ServiceConnection, ServiceName, type ServiceRoute } from "@lando/sdk/schema";
import { Effect } from "effect";
import { runPostStartScan, startupScanUrls } from "../../src/operations/post-start-scan.ts";
import { plan, web } from "./start-progress-topology-support.ts";

const host = (url: string) =>
  ({
    scope: "host",
    source: "publication",
    binding: "assigned",
    state: "active",
    protocol: "http",
    host: URL.parse(url)?.hostname ?? "localhost",
    port: 8080,
    url,
    alternateUrls: [],
    endpoint: { port: 3000, transport: "tcp", names: [], primary: true },
  }) satisfies ServiceConnection;

test("scans only active assigned host HTTP connections and deduplicates them", () => {
  const assigned = host("http://localhost:8080");
  const connections: ServiceConnection[] = [
    assigned,
    assigned,
    { ...assigned, state: "inactive" },
    { ...assigned, state: "unknown" },
    { ...assigned, protocol: "tcp", url: "tcp://localhost:8080" },
    { ...assigned, scope: "app", source: "listener" },
    {
      scope: "host",
      source: "publication",
      binding: "pending",
      protocol: "http",
      state: "unknown",
      host: "localhost",
      endpoint: assigned.endpoint,
    },
  ];
  const urls = startupScanUrls(plan, [{ name: "web", state: "running", connections, routes: [] }]);
  expect(urls).toEqual([{ service: web.name, url: "http://localhost:8080/", endpoint: assigned.endpoint }]);
});

test("skips a hostname pattern but scans a concrete route with an asterisk in its path", () => {
  const url = "https://web.demo.test/files/*";
  const exact = {
    endpoint: host(url).endpoint,
    host: "web.demo.test",
    binding: "assigned",
    state: "active",
    protocol: "https",
    port: 443,
    pathPrefix: "/files/*",
    hostMatch: "exact",
    url,
  } satisfies ServiceRoute;
  const { url: _url, ...route } = exact;
  const pattern = { ...route, host: "*.demo.test", hostMatch: "pattern" } satisfies ServiceRoute;
  const urls = startupScanUrls(plan, [
    { name: "web", state: "running", connections: [], routes: [pattern, exact] },
  ]);
  expect(urls).toEqual([
    { service: web.name, url: "https://web.demo.test/files/*/", endpoint: exact.endpoint },
  ]);
});

test("preserves route prefixes when appending a configured scanner path", () => {
  const planned = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        scanner: { enabled: true, path: "/ready", okCodes: [], retries: 0, timeoutMs: 1000 },
      },
    },
  };
  const urls = startupScanUrls(planned, [
    {
      name: "web",
      state: "ready",
      connections: [],
      routes: [
        {
          endpoint: host("https://web.demo.test/api").endpoint,
          host: "web.demo.test",
          binding: "assigned",
          state: "active",
          protocol: "https",
          port: 443,
          pathPrefix: "/api",
          hostMatch: "exact",
          url: "https://web.demo.test/api",
        },
      ],
    },
  ]);
  expect(urls).toEqual([
    {
      service: web.name,
      url: "https://web.demo.test/api/ready",
      endpoint: host("https://web.demo.test/api").endpoint,
    },
  ]);
});

test("never probes disabled or non-HTTP targets", async () => {
  let calls = 0;
  const disabledPlan = {
    ...plan,
    services: {
      [web.name]: {
        ...web,
        scanner: { enabled: false, path: "/", okCodes: [], retries: 0, timeoutMs: 1000 },
      },
    },
  };
  await Effect.runPromise(
    runPostStartScan({
      plan: disabledPlan,
      scanner: {
        id: "test",
        scan: () =>
          Effect.sync(() => {
            calls++;
            return { appId: plan.id, endpoints: [] };
          }),
        detectCollisions: () => Effect.succeed([]),
      },
      events: {
        publish: () =>
          Effect.sync(() => {
            calls++;
          }),
      },
      urls: [
        { service: web.name, url: "http://localhost:8080/" },
        { service: ServiceName.make("db"), url: "tcp://localhost:5432" },
      ],
    }),
  );
  expect(calls).toBe(0);
});
