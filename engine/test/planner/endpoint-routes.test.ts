import { expect, test } from "bun:test";
import { type CertificatePlan, type EndpointPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { resolveRoute } from "../../src/planner/endpoints.ts";
import { stampGeneratedBackendTls } from "../../src/planner/route-certificate-defaults.ts";

const endpoints: readonly EndpointPlan[] = [
  { kind: "internal", protocol: "http", port: 9000, name: "admin" },
  { kind: "published", protocol: "udp", port: 8080, publication: {} },
  {
    kind: "published",
    protocol: "http",
    port: 8080,
    name: "browser",
    primary: true,
    publication: { hostPort: 18080 },
  },
  { kind: "internal", protocol: "http", port: 8080, name: "web", primary: true },
];

const certificate: CertificatePlan = { cn: "web.app.internal", sans: ["web.app.internal"], caId: "mkcert" };

test.each([{ selector: undefined }, { selector: 8080 }, { selector: "browser" }, { selector: "web" }])(
  "resolves a logical HTTP listener independent of facet order: %j",
  async ({ selector }) => {
    // Given
    const route = {
      hostname: "app.test",
      ...(selector === undefined ? {} : { endpoint: selector }),
      pathPrefix: "/api",
      filters: [],
    };
    // When
    const routes = await Effect.runPromise(
      Effect.forEach([endpoints, [...endpoints].reverse()], (facets) =>
        resolveRoute("/app", "web", facets, route, false),
      ),
    );
    // Then
    for (const resolved of routes) {
      expect(resolved).toHaveLength(1);
      expect(resolved[0]?.backend).toEqual({
        service: ServiceName.make("web"),
        port: 8080,
        protocol: "http",
      });
      expect(resolved[0]?.pathPrefix).toBe("/api");
    }
  },
);

test("selects a named secondary instead of the marked HTTP primary", async () => {
  // Given
  const route = { hostname: "admin.test", endpoint: "admin", filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", endpoints, route, false));
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.backend.port).toBe(9000);
});

test("uses the unique HTTP listener when a non-HTTP listener is primary", async () => {
  // Given
  const facets: readonly EndpointPlan[] = [
    { kind: "internal", protocol: "tcp", port: 1025, primary: true },
    { kind: "internal", protocol: "http", port: 8025 },
  ];
  // When
  const resolved = await Effect.runPromise(
    resolveRoute("/app", "mail", facets, { hostname: "mail.test", filters: [] }, false),
  );
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.backend.port).toBe(8025);
});

test.each([
  { facets: [] },
  {
    facets: [
      { kind: "internal", protocol: "http", port: 80 },
      { kind: "internal", protocol: "http", port: 90 },
    ],
  },
])("rejects unresolved HTTP selection: %j", async ({ facets }) => {
  // Given
  const route = { hostname: "app.test", filters: [] };
  // When
  const result = await Effect.runPromise(Effect.result(resolveRoute("/app", "web", facets, route, false)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "web", "routes"] }],
    });
});

const dualListener = (): readonly EndpointPlan[] => [
  { kind: "internal", protocol: "http", port: 80, name: "web", primary: true },
  { kind: "internal", protocol: "https", port: 443, name: "web-https" },
];

const defaultRoute = { hostname: "app.test", filters: [] };

test("binds both as independent HTTP then HTTPS plans from a generated certificate", async () => {
  // Given
  const route = { hostname: "app.test", scheme: "both" as const, filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), route, true));
  // Then
  expect(resolved.map((plan) => [plan.scheme, plan.backend.port, plan.backend.protocol])).toEqual([
    ["http", 80, "http"],
    ["https", 443, "https"],
  ]);
});

test("default HTTPS selects the generated HTTPS secondary over an HTTP primary", async () => {
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), defaultRoute, true));
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).toMatchObject({ scheme: "https", backend: { port: 443, protocol: "https" } });
});

test("an authored HTTP selector ignores the HTTPS preference on both plans", async () => {
  // Given
  const route = { hostname: "app.test", scheme: "both" as const, endpoint: "web", filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), route, true));
  // Then
  expect(resolved.map((plan) => plan.backend.port)).toEqual([80, 80]);
});

test("never partially publishes both when one half cannot select", async () => {
  // Given
  const onlyHttp: readonly EndpointPlan[] = [
    { kind: "internal", protocol: "http", port: 80, name: "web", primary: true },
  ];
  // When
  const resolved = await Effect.runPromise(
    Effect.result(
      resolveRoute("/app", "web", onlyHttp, { hostname: "app.test", scheme: "both", filters: [] }, false),
    ),
  );
  // Then
  expect(Result.isSuccess(resolved)).toBe(true);
  if (Result.isSuccess(resolved))
    expect(resolved.success.map((plan) => [plan.scheme, plan.backend.port])).toEqual([
      ["http", 80],
      ["https", 80],
    ]);
});

test("fails both when the HTTPS half is ambiguous", async () => {
  // Given
  const ambiguous: readonly EndpointPlan[] = [
    { kind: "internal", protocol: "http", port: 80, primary: true },
    { kind: "internal", protocol: "https", port: 443 },
    { kind: "internal", protocol: "https", port: 8443 },
  ];
  // When
  const resolved = await Effect.runPromise(
    Effect.result(
      resolveRoute("/app", "web", ambiguous, { hostname: "app.test", scheme: "both", filters: [] }, true),
    ),
  );
  // Then
  expect(Result.isFailure(resolved)).toBe(true);
});

test("binds an HTTPS route to the plain primary when the router cannot verify an HTTPS listener", async () => {
  // Given: a primary HTTP listener beside an unmarked HTTPS listener with its own certificate.
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), defaultRoute, false));
  // Then: no preference, so the legacy primary wins and finalization leaves TLS at the router.
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.backend).toEqual({ service: ServiceName.make("web"), port: 80, protocol: "http" });
  const [plan] = stampGeneratedBackendTls(resolved, { certificate: undefined, generated: false });
  expect(plan?.backend.tls).toBeUndefined();
});

test("binds an HTTPS route to the HTTPS listener when the service holds a generated certificate", async () => {
  // Given
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), defaultRoute, true));
  // Then: the router verifies that backend against the generated certificate.
  expect(resolved[0]?.backend).toEqual({ service: ServiceName.make("web"), port: 443, protocol: "https" });
  const [plan] = stampGeneratedBackendTls(resolved, { certificate, generated: true });
  expect(plan?.backend.tls).toEqual({ caId: "mkcert", serverName: "web.app.internal" });
});

test("reports ambiguity for unmarked HTTP and HTTPS listeners without a generated certificate", async () => {
  // Given
  const unmarked: readonly EndpointPlan[] = [
    { kind: "internal", protocol: "http", port: 80 },
    { kind: "internal", protocol: "https", port: 443 },
  ];
  // When: an HTTPS route takes the unrestricted set, while an HTTP route prefers HTTP.
  const https = await Effect.runPromise(
    Effect.result(resolveRoute("/app", "web", unmarked, { hostname: "secure.test", filters: [] }, false)),
  );
  const http = await Effect.runPromise(
    resolveRoute("/app", "web", unmarked, { hostname: "plain.test", scheme: "http", filters: [] }, false),
  );
  // Then
  expect(Result.isFailure(https)).toBe(true);
  if (Result.isFailure(https))
    expect(https.failure).toMatchObject({
      issues: [{ message: expect.stringContaining("ambiguous") }],
    });
  expect(http.map((plan) => [plan.scheme, plan.backend.port])).toEqual([["http", 80]]);
});
