import { expect, test } from "bun:test";
import { RouteInputError } from "@lando/sdk/errors";
import { RoutePlan } from "@lando/sdk/schema";
import { Effect, Either, Schema } from "effect";
import { makeRouteAccumulator, prioritizeRoutes } from "../../src/planner/route-identity.ts";

const route = (overrides: Partial<RoutePlan> = {}): RoutePlan =>
  Schema.decodeUnknownSync(RoutePlan)({
    hostname: "app.example.test",
    scheme: "https",
    service: "web",
    backend: { service: "web", protocol: "http", port: 80 },
    ...overrides,
  });

test.each(["http", "https"] as const)(
  "rejects conflicting %s overlap with both before provider action",
  async (scheme) => {
    // Given
    const accumulator = makeRouteAccumulator();
    await Effect.runPromise(
      accumulator.add(route({ scheme: "both" }), { key: "services.web.routes[0]", file: "/app/base.yml" }),
    );
    // When
    const result = await Effect.runPromise(
      Effect.either(
        accumulator.add(route({ scheme, filters: [{ type: "addPrefix", prefix: "/v2" }] }), {
          key: "proxy.web[0]",
          file: "/app/local.yml",
        }),
      ),
    );
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) throw new Error("expected conflict");
    expect(result.left).toBeInstanceOf(RouteInputError);
    expect(result.left).toMatchObject({ file: "/app/local.yml", key: "proxy.web[0]" });
    expect(result.left.message).toContain("/app/base.yml:services.web.routes[0]");
  },
);

test.each([true, false])(
  "dedupes equivalent partial scheme overlap when both comes first: %s",
  async (bothFirst) => {
    // Given
    const accumulator = makeRouteAccumulator();
    const inputs = bothFirst ? (["both", "http", "https"] as const) : (["http", "https", "both"] as const);
    // When
    for (const scheme of inputs)
      await Effect.runPromise(accumulator.add(route({ scheme, filters: [] }), { key: `routes.${scheme}` }));
    // Then
    expect(
      accumulator.routes
        .flatMap((item) => (item.scheme === "both" ? ["http", "https"] : [item.scheme]))
        .sort(),
    ).toEqual(["http", "https"]);
  },
);

test("dedupes filter execution semantics regardless of merge identity names", async () => {
  // Given
  const accumulator = makeRouteAccumulator();
  await Effect.runPromise(
    accumulator.add(route({ filters: [{ type: "redirect", name: "first", to: "https://new.test" }] }), {
      key: "routes[0]",
    }),
  );
  // When
  const refs = await Effect.runPromise(
    accumulator.add(
      route({ filters: [{ type: "redirect", name: "second", to: "https://new.test", permanent: false }] }),
      { key: "routes[1]" },
    ),
  );
  // Then
  expect(refs).toEqual([{ index: 0 }]);
  expect(accumulator.routes).toHaveLength(1);
});

test("rejects a different selected backend port for the same listener match", async () => {
  // Given
  const accumulator = makeRouteAccumulator();
  const first = route();
  await Effect.runPromise(accumulator.add(first, { key: "routes[0]" }));
  // When
  const result = await Effect.runPromise(
    Effect.either(
      accumulator.add(route({ endpoint: 8080, backend: { ...first.backend, port: 8080 } }), {
        key: "routes[1]",
      }),
    ),
  );
  // Then
  expect(Either.isLeft(result)).toBe(true);
});

test("dedupes omitted filters and empty filters, and hostname case", async () => {
  // Given
  const accumulator = makeRouteAccumulator();
  await Effect.runPromise(accumulator.add(route(), { key: "routes[0]" }));
  // When
  const refs = await Effect.runPromise(
    accumulator.add(route({ hostname: "APP.example.test", filters: [] }), { key: "routes[1]" }),
  );
  // Then
  expect(refs).toEqual([{ index: 0 }]);
});

test("ranks exact over wildcard and longest paths without path-length or route-count caps", () => {
  // Given
  const routes = [
    route({ hostname: "*.example.test", pathPrefix: `/${"x".repeat(10001)}` }),
    ...Array.from({ length: 1001 }, (_, index) => route({ pathPrefix: `/${"x".repeat(index)}` })),
  ];
  // When
  const ranked = prioritizeRoutes(routes);
  // Then
  expect(new Set(ranked.map((item) => item.priority)).size).toBe(1002);
  expect(ranked[0]?.priority).toBe(2);
  expect(ranked.at(-1)?.priority).toBe(1003);
});

test("uses lexical hostname ties independent of input order", () => {
  // Given
  const routes = [
    route({ hostname: "*.z.test" }),
    route({ hostname: "z.*.test" }),
    route({ hostname: "*.a.test" }),
  ];
  // When
  const ranked = prioritizeRoutes(routes);
  const reversed = prioritizeRoutes([...routes].reverse());
  // Then
  const byHost = (items: readonly RoutePlan[]) =>
    Object.fromEntries(items.map((item) => [item.hostname, item.priority]));
  expect(byHost(ranked)).toEqual(byHost(reversed));
  expect(byHost(ranked)).toEqual({ "*.a.test": 4, "*.z.test": 3, "z.*.test": 2 });
});
