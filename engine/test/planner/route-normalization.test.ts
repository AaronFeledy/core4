import { expect, test } from "bun:test";
import { Effect, Either, Layer, Schema } from "effect";

import { RouteInputError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const plan = (input: unknown) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(Schema.decodeUnknownSync(LandofileShape)(input), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLive.pipe(Layer.provide(PluginRegistryLive))));

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
