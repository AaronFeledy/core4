import { expect, test } from "bun:test";
import { RouteInputError } from "@lando/sdk/errors";
import {
  ROUTE_PATH_WEIGHT_CAP,
  ROUTE_PRIORITY_DIAGNOSTIC,
  ROUTE_PRIORITY_EXACT_BASE,
  ROUTE_PRIORITY_MAX,
  ROUTE_PRIORITY_WILDCARD_BASE,
  RoutePlan,
} from "@lando/sdk/schema";
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

test("keeps the minimum exact priority above the capped maximum wildcard priority", () => {
  // Given
  const routes = [
    route({ hostname: "www.a.test" }),
    route({ hostname: "*.a.test", pathPrefix: `/${"x".repeat(70_000)}` }),
  ];
  // When
  const [exact, wildcard] = prioritizeRoutes(routes);
  // Then
  if (exact === undefined || wildcard === undefined) throw new Error("expected both ranked routes");
  expect(exact.priority).toBeGreaterThan(wildcard.priority);
  expect(exact.priority).toBe(ROUTE_PRIORITY_EXACT_BASE + "/".length);
  expect(wildcard.priority).toBe(ROUTE_PRIORITY_WILDCARD_BASE + ROUTE_PATH_WEIGHT_CAP);
});

test.each(["www.a.test", "*.a.test"])("increases priority with path length within %s", (hostname) => {
  // Given
  const routes = ["/", "/a", "/ab"].map((pathPrefix) => route({ hostname, pathPrefix }));
  // When
  const [root, short, long] = prioritizeRoutes(routes);
  // Then
  if (root === undefined || short === undefined || long === undefined)
    throw new Error("expected all three ranked paths");
  expect(short.priority).toBeGreaterThan(root.priority);
  expect(long.priority).toBeGreaterThan(short.priority);
});

test.each(["www.a.test", "*.a.test"])(
  "keeps %s priority identical alone, with 1000 other routes, and after reversal",
  (hostname) => {
    // Given
    const target = route({ hostname, pathPrefix: "/api" });
    const routes = [
      target,
      ...Array.from({ length: 1000 }, (_, index) =>
        route({ hostname: index % 2 === 0 ? `*.other-${index}.test` : `other-${index}.test` }),
      ),
    ];
    // When
    const alone = prioritizeRoutes([target])[0];
    const inPlan = prioritizeRoutes(routes).find((item) => item.hostname === hostname);
    const reversed = prioritizeRoutes([...routes].reverse()).find((item) => item.hostname === hostname);
    // Then
    expect(alone).toBeDefined();
    expect(inPlan).toBeDefined();
    expect(reversed).toBeDefined();
    expect(inPlan?.priority).toBe(alone?.priority);
    expect(reversed?.priority).toBe(alone?.priority);
    expect(reversed?.priority).toBe(inPlan?.priority);
  },
);

test.each([
  [route({ hostname: "*.a.test" }), route({ hostname: "*.z.test" })],
  [route({ hostname: "www.a.test", pathPrefix: "/x" }), route({ hostname: "www.b.test", pathPrefix: "/y" })],
])("gives equal priority to equally specific routes: %o and %o", (first, second) => {
  // Given
  const routes = [first, second];
  // When
  const [left, right] = prioritizeRoutes(routes);
  // Then
  expect(left).toBeDefined();
  expect(right).toBeDefined();
  expect(left?.priority).toBe(right?.priority);
});

test("keeps every priority inside the published space and above diagnostics", () => {
  // Given
  const routes = [
    route({ hostname: "*.a.test" }),
    route({ hostname: "www.a.test" }),
    route({ hostname: "*.z.test", pathPrefix: `/${"x".repeat(70_000)}` }),
    route({ hostname: "www.z.test", pathPrefix: `/${"x".repeat(70_000)}` }),
  ];
  // When
  const ranked = prioritizeRoutes(routes);
  // Then
  for (const item of ranked) {
    expect(item.priority).toBeGreaterThanOrEqual(ROUTE_PRIORITY_WILDCARD_BASE);
    expect(item.priority).toBeLessThanOrEqual(ROUTE_PRIORITY_MAX);
    expect(item.priority).toBeGreaterThan(ROUTE_PRIORITY_DIAGNOSTIC);
  }
});

test("preserves route array length and input indexes when assigning priorities", () => {
  // Given
  const routes = [
    route({ hostname: "*.z.test" }),
    route({ hostname: "www.a.test", pathPrefix: "/a" }),
    route({ hostname: "www.a.test", pathPrefix: "/ab" }),
    route({ hostname: "*.a.test" }),
  ];
  // When
  const ranked = prioritizeRoutes(routes);
  // Then
  expect(ranked).toHaveLength(routes.length);
  expect(ranked.map(({ hostname, pathPrefix }) => [hostname, pathPrefix])).toEqual(
    routes.map(({ hostname, pathPrefix }) => [hostname, pathPrefix]),
  );
});
