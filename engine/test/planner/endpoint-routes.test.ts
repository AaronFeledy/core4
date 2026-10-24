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
      expect(resolved.backend).toEqual({ service: ServiceName.make("web"), port: 8080, protocol: "http" });
      expect(resolved.pathPrefix).toBe("/api");
    }
  },
);

test("selects a named secondary instead of the marked HTTP primary", async () => {
  // Given
  const route = { hostname: "admin.test", endpoint: "admin", filters: [] };
  // When
  const resolved = await Effect.runPromise(resolveRoute("/app", "web", endpoints, route));
  // Then
  expect(resolved.backend.port).toBe(9000);
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
  expect(resolved.backend.port).toBe(8025);
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
