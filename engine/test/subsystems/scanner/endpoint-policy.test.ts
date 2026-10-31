import { expect, test } from "bun:test";
import { type AppPlan, type EndpointPlan, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { runPostStartScan, startupScanUrls } from "../../../src/operations/post-start-scan.ts";
import { makeUrlScanner } from "../../../src/subsystems/scanner/live.ts";
import { plan, web } from "../../operations/start-progress-topology-support.ts";
import { drive, endpointsOf, httpStatus, publishedEndpoint, requestSequence } from "./support.ts";

const service = ServiceName.make("storage");
const endpoints: readonly EndpointPlan[] = [
  { _tag: "internal", protocol: "http", port: 9000, scan: { path: "/minio/health/live", okCodes: [418] } },
  { _tag: "internal", protocol: "http", port: 9001, scan: { path: "/", okCodes: [] } },
];
const planned: AppPlan = {
  ...plan,
  services: { [service]: {
    ...web, name: service, type: "minio", endpoints,
    scanner: { enabled: true, path: "/fallback", okCodes: [403], retries: 0, timeoutMs: 1000 },
  } },
};
const connections = [9000, 9001].map((port) => ({
  ...publishedEndpoint(service, "http", port + 10000),
  endpoint: { port, transport: "tcp" as const, names: [], primary: false },
}));

test("startup and discovered scans use logical per-port paths and status codes", async () => {
  // Given
  const http = requestSequence([httpStatus(418)]);
  const scanner = makeUrlScanner({ http: http.http, ...endpointsOf(connections) });
  // When
  const startup = startupScanUrls(planned, [{ name: service, state: "running", connections }]);
  const discovered = await drive(scanner.scan(plan.id, { plan: planned }));
  // Then
  expect(startup.map(({ url }) => url)).toEqual([
    "http://localhost:19000/minio/health/live", "http://localhost:19001/",
  ]);
  expect(discovered.endpoints.map(({ url, verdict }) => ({ url, verdict }))).toEqual([
    { url: "http://localhost:19000/minio/health/live", verdict: "ready" },
    { url: "http://localhost:19001/", verdict: "app-error" },
  ]);
});

test("post-start passes endpoint refs through to status-policy selection", async () => {
  // Given
  const http = requestSequence([httpStatus(418)]);
  const scanner = makeUrlScanner({ http: http.http, ...endpointsOf([]) });
  // When
  const checks = await drive(runPostStartScan({
    scanner, plan: planned, events: { publish: () => Effect.void },
    urls: startupScanUrls(planned, [{ name: service, state: "running", connections }]),
  }));
  // Then
  expect(checks.map(({ verdict }) => verdict)).toEqual(["ready", "app-error"]);
});

test("endpoint defaults never enable a plan-disabled service", async () => {
  // Given
  const http = requestSequence([httpStatus(200)]);
  const scanner = makeUrlScanner({ http: http.http, ...endpointsOf(connections) });
  const disabled: AppPlan = { ...planned, services: { [service]: {
    ...web, name: service, endpoints,
    scanner: { enabled: false, path: "/", okCodes: [], retries: 0, timeoutMs: 1000 },
  } } };
  // When
  const result = await drive(scanner.scan(plan.id, { plan: disabled }));
  const startup = startupScanUrls(disabled, [{ name: service, state: "running", connections }]);
  // Then
  expect(result.endpoints).toEqual([]);
  expect(startup).toEqual([]);
  expect(http.requests).toEqual([]);
});

test("supplied refs select status policy without appending a second path or guessing the host port", async () => {
  // Given
  const http = requestSequence([httpStatus(418)]);
  const source = endpointsOf([]);
  const scanner = makeUrlScanner({ http: http.http, ...source });
  const urls = startupScanUrls(planned, [{ name: service, state: "running", connections }]);
  // When
  const result = await drive(scanner.scan(plan.id, { plan: planned, urls }));
  // Then
  expect(result.endpoints.map(({ verdict }) => verdict)).toEqual(["ready", "app-error"]);
  expect(http.requests.map(({ url }) => url)).toEqual([
    "http://localhost:19000/minio/health/live", "http://localhost:19001/",
  ]);
  expect(source.calls).toEqual([]);
});

test("route prefixes are included exactly once with endpoint-specific paths", () => {
  // Given
  const connection = connections[0];
  if (connection === undefined) throw new Error("missing fixture");
  // When
  const urls = startupScanUrls(planned, [{ name: service, state: "running", connections: [{
    ...connection, scope: "host", binding: "assigned", protocol: "https", port: 443, alternateUrls: [],
    source: "route", pathPrefix: "/storage", url: "https://storage.test/storage",
  }] }]);
  // Then
  expect(urls.map(({ url }) => url)).toEqual(["https://storage.test/storage/minio/health/live"]);
});

test("missing endpoint refs use service policy even when the URL resembles a known listener", async () => {
  // Given
  const http = requestSequence([httpStatus(403)]);
  const scanner = makeUrlScanner({ http: http.http, ...endpointsOf([]) });
  // When
  const result = await drive(scanner.scan(plan.id, { plan: planned, urls: [
    { service, url: "http://localhost:9000/already-complete" },
  ] }));
  // Then
  expect(result.endpoints[0]?.verdict).toBe("ready");
  expect(http.requests.map(({ url }) => url)).toEqual(["http://localhost:9000/already-complete"]);
});

test("historical plans without endpoint scan metadata use service fallback without type inference", async () => {
  // Given
  const http = requestSequence([httpStatus(403)]);
  const scanner = makeUrlScanner({ http: http.http, ...endpointsOf(connections) });
  const historical: AppPlan = { ...planned, services: { [service]: {
    ...web, name: service, type: "minio",
    scanner: { enabled: true, path: "/legacy", okCodes: [403], retries: 0, timeoutMs: 1000 },
    endpoints: endpoints.map(({ scan: _scan, ...endpoint }) => endpoint),
  } } };
  // When
  const result = await drive(scanner.scan(plan.id, { plan: historical }));
  // Then
  expect(result.endpoints.map(({ url, verdict }) => ({ url, verdict }))).toEqual([
    { url: "http://localhost:19000/legacy", verdict: "ready" },
    { url: "http://localhost:19001/legacy", verdict: "ready" },
  ]);
});
