import { expect, test } from "bun:test";
import { type EndpointPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { resolveRoute } from "../../src/planner/endpoints.ts";

const endpoints: readonly EndpointPlan[] = [
  { _tag: "internal", protocol: "http", port: 9000, name: "admin" },
  { _tag: "published", protocol: "udp", port: 8080, publication: {} },
  {
    _tag: "published",
    protocol: "http",
    port: 8080,
    name: "browser",
    primary: true,
    publication: { hostPort: 18080 },
  },
  { _tag: "internal", protocol: "http", port: 8080, name: "web", primary: true },
];

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
        resolveRoute("/app", "web", facets, route),
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
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", endpoints, route));
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.backend.port).toBe(9000);
});

test("uses the unique HTTP listener when a non-HTTP listener is primary", async () => {
  // Given
  const facets: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "tcp", port: 1025, primary: true },
    { _tag: "internal", protocol: "http", port: 8025 },
  ];
  // When
  const resolved = await Effect.runPromise(
    resolveRoute("/app", "mail", facets, { hostname: "mail.test", filters: [] }),
  );
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.backend.port).toBe(8025);
});

test.each([
  { facets: [] },
  {
    facets: [
      { _tag: "internal", protocol: "http", port: 80 },
      { _tag: "internal", protocol: "http", port: 90 },
    ],
  },
])("rejects unresolved HTTP selection: %j", async ({ facets }) => {
  // Given
  const route = { hostname: "app.test", filters: [] };
  // When
  const result = await Effect.runPromise(Effect.result(resolveRoute("/app", "web", facets, route)));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "web", "routes"] }],
    });
});

const dualListener = (): readonly EndpointPlan[] => [
  { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
  { _tag: "internal", protocol: "https", port: 443, name: "web-https" },
];

test("binds both as independent HTTP then HTTPS plans", async () => {
  // Given
  const route = { hostname: "app.test", scheme: "both" as const, filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), route));
  // Then
  expect(resolved.map((plan) => [plan.scheme, plan.backend.port, plan.backend.protocol])).toEqual([
    ["http", 80, "http"],
    ["https", 443, "https"],
  ]);
});

test("default HTTPS selects the generated HTTPS secondary over an HTTP primary", async () => {
  // Given
  const route = { hostname: "app.test", filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), route));
  // Then
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).toMatchObject({ scheme: "https", backend: { port: 443, protocol: "https" } });
});

test("an authored HTTP selector ignores the HTTPS preference on both plans", async () => {
  // Given
  const route = { hostname: "app.test", scheme: "both" as const, endpoint: "web", filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", dualListener(), route));
  // Then
  expect(resolved.map((plan) => plan.backend.port)).toEqual([80, 80]);
});

test("never partially publishes both when one half cannot select", async () => {
  // Given
  const onlyHttp: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "http", port: 80, name: "web", primary: true },
  ];
  // When
  const resolved = await Effect.runPromise(
    Effect.result(
      resolveRoute("/app", "web", onlyHttp, { hostname: "app.test", scheme: "both", filters: [] }),
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
    { _tag: "internal", protocol: "http", port: 80, primary: true },
    { _tag: "internal", protocol: "https", port: 443 },
    { _tag: "internal", protocol: "https", port: 8443 },
  ];
  // When
  const resolved = await Effect.runPromise(
    Effect.result(
      resolveRoute("/app", "web", ambiguous, { hostname: "app.test", scheme: "both", filters: [] }),
    ),
  );
  // Then
  expect(Result.isFailure(resolved)).toBe(true);
});
