import { expect, test } from "bun:test";
import { Effect, Either, Layer, Schema } from "effect";

import { RouteInputError } from "@lando/sdk/errors";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const plan = (input: unknown) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(Schema.decodeUnknownSync(LandofileShape)(input), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLive.pipe(Layer.provide(PluginRegistryLive))));

test("preserves distinct paths when routes share a host", async () => {
  // Given
  const input = {
    name: "route-identity",
    services: { web: { type: "nginx", routes: ["same.example.test/api", "same.example.test/admin"] } },
  };
  // When
  const result = await Effect.runPromise(plan(input));
  // Then
  expect(result.routes.map((route) => route.pathPrefix)).toEqual(["/api", "/admin"]);
  expect(result.services[ServiceName.make("web")]?.routes).toEqual([{ index: 0 }, { index: 1 }]);
});

test("plans shorthand routes with endpoint and pathPrefix", async () => {
  // Given
  const input = {
    name: "routes-app",
    services: { web: { type: "nginx", routes: ["web.example.test:80/api"] } },
    proxy: { web: ["alias.example.test:80/other"] },
  };
  // When
  const result = await Effect.runPromise(plan(input));
  // Then
  expect(result.routes).toMatchObject([
    {
      hostname: "web.example.test",
      scheme: "https",
      endpoint: 80,
      pathPrefix: "/api",
      backend: { port: 80 },
    },
    {
      hostname: "alias.example.test",
      scheme: "https",
      endpoint: 80,
      pathPrefix: "/other",
      backend: { port: 80 },
    },
  ]);
});

test("keeps separate HTTP and HTTPS backends on the same host and path", async () => {
  // Given
  const input = {
    name: "schemes",
    services: {
      web: { type: "nginx", routes: [{ hostname: "same.test", scheme: "http" }] },
      secure: { type: "nginx", routes: [{ hostname: "same.test", scheme: "https" }] },
    },
  };
  // When
  const result = await Effect.runPromise(plan(input));
  // Then
  expect(result.routes.map(({ scheme, backend }) => [scheme, String(backend.service)]).sort()).toEqual([
    ["http", "web"],
    ["https", "secure"],
  ]);
});

test("rejects conflicting proxy and service declarations with authored source keys", async () => {
  // Given
  const input = {
    name: "conflicts",
    services: { web: { type: "nginx", routes: ["same.test"] } },
    proxy: { web: [{ hostname: "same.test", filters: [{ type: "addPrefix", prefix: "/new" }] }] },
  };
  // When
  const result = await Effect.runPromise(Effect.either(plan(input)));
  // Then
  if (Either.isRight(result)) throw new Error("expected conflict");
  expect(result.left).toBeInstanceOf(RouteInputError);
  expect(result.left).toMatchObject({ key: "proxy.web[0]" });
  expect(result.left.message).toContain("services.web.routes[0]");
  expect(result.left).not.toHaveProperty("file");
});

test("dedupes equivalent proxy and service declarations without duplicate service refs", async () => {
  // Given
  const input = {
    name: "duplicates",
    services: { web: { type: "nginx", routes: ["same.test:80"] } },
    proxy: { web: [{ hostname: "same.test", filters: [] }] },
  };
  // When
  const result = await Effect.runPromise(plan(input));
  // Then
  expect(result.routes).toHaveLength(1);
  expect(result.services[ServiceName.make("web")]?.routes).toEqual([{ index: 0 }]);
});

test("carries filters onto RoutePlan unchanged and omits the key when empty", async () => {
  // Given
  const filters = [
    { type: "stripPrefix", prefix: "/api" },
    { type: "addPrefix", prefix: "/v1" },
  ] as const;
  const input = {
    name: "routes-app",
    services: {
      web: {
        type: "nginx",
        routes: [
          { hostname: "filtered.example.test", filters },
          { hostname: "plain.example.test", filters: [] },
        ],
      },
    },
  };
  // When
  const result = await Effect.runPromise(plan(input));
  // Then
  expect(result.routes[0]?.filters).toEqual(filters);
  expect(result.routes[1]).not.toHaveProperty("filters");
});

test("rejects invalid route shorthand with RouteInputError before any provider action", async () => {
  // Given: only capabilities are supplied; no provider action service exists in the planner layer.
  const input = {
    name: "routes-app",
    services: { web: { type: "nginx", routes: ["ftp://bad.example.test"] } },
  };
  // When
  const result = await Effect.runPromise(Effect.either(plan(input)));
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) throw new Error("expected route rejection");
  expect(result.left).toBeInstanceOf(RouteInputError);
  expect(result.left).toMatchObject({ key: "services.web.routes[0]" });
});

test("keys top-level proxy routes as proxy.<svc>[i]", async () => {
  // Given
  const input = {
    name: "routes-app",
    services: { web: { type: "nginx", routes: ["service.example.test"] } },
    proxy: { web: ["alias.example.test", "ftp://bad.example.test"] },
  };
  // When
  const result = await Effect.runPromise(Effect.either(plan(input)));
  // Then
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isRight(result)) throw new Error("expected route rejection");
  expect(result.left).toBeInstanceOf(RouteInputError);
  expect(result.left).toMatchObject({ key: "proxy.web[1]" });
});
