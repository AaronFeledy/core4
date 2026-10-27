import { expect, test } from "bun:test";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { acceptsAllRoutes } from "../src/route-acceptance.ts";
import { matchesLiveRoute } from "../src/route-evidence-match.ts";
import { renderTraefikDynamicConfig } from "../src/routing.ts";
import { persistedRuntimeGraph } from "./apply-runtime-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

const first = httpsRoutes[0];
if (first === undefined) throw new Error("route fixture missing");
const route = { ...first, scheme: "both" as const };
const graphFor = (routes = [route]) =>
  persistedRuntimeGraph(new Map([["routes-demo.yml", renderTraefikDynamicConfig(routes, app)]]));

test("waits through empty and partial graphs until every requested scheme is accepted", async () => {
  const fixture = makeAcceptanceFixture();
  fixture.runtime.setGraph({ routers: {}, services: {} });
  let completed = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        fixture.service.applyRoutes([route], app).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
      );
      yield* TestClock.adjust(0);
      expect(completed).toBe(false);
      expect(yield* fixture.service.readAppliedRoutes(app)).toEqual([]);
      const full = graphFor();
      const { "route-demo%2Fapp-0-https@file": _https, ...routers } = full.routers;
      fixture.runtime.setGraph({ ...full, routers });
      yield* TestClock.adjust(250);
      expect(completed).toBe(false);
      fixture.runtime.setGraph(full);
      yield* TestClock.adjust(250);
      yield* Fiber.join(fiber);
      expect(yield* Clock.currentTimeMillis).toBe(500);
      expect(fixture.runtime.requests).toHaveLength(3);
      expect(yield* fixture.service.readAppliedRoutes(app)).toEqual([route]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("accepts a complete graph on the first attempt without advancing the clock", async () => {
  const fixture = makeAcceptanceFixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* fixture.service.applyRoutes([route], app);
      expect(yield* Clock.currentTimeMillis).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(fixture.runtime.requests).toHaveLength(1);
});

test("replacement waits for stale app routers to disappear", async () => {
  const fixture = makeAcceptanceFixture();
  const second = { ...route, hostname: "second.example.test" };
  await Effect.runPromise(fixture.service.applyRoutes([route, second], app));
  fixture.runtime.setGraph(graphFor([route, second]));
  let completed = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        fixture.service.applyRoutes([route], app).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
      );
      yield* TestClock.adjust(0);
      expect(completed).toBe(false);
      fixture.runtime.setGraph(graphFor());
      yield* TestClock.adjust(250);
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(completed).toBe(true);
});

test.each(["backend", "priority", "middleware", "entrypoint", "tls", "index", "rule"] as const)(
  "rejects a graph with incorrect %s",
  (mismatch) => {
    const graph = graphFor();
    const key = "route-demo%2Fapp-0-http@file";
    const router = graph.routers[key];
    if (router === undefined) throw new Error("router fixture missing");
    let routers = { ...graph.routers };
    let services = graph.services;
    switch (mismatch) {
      case "backend":
        services = {
          "route-demo%2Fapp-0@file": {
            status: "enabled",
            loadBalancer: { servers: [{ url: "http://wrong:9999" }] },
          },
        };
        break;
      case "priority":
        routers[key] = { ...router, priority: route.priority + 1 };
        break;
      case "middleware":
        routers[key] = { ...router, middlewares: ["unexpected@file"] };
        break;
      case "entrypoint":
        routers[key] = { ...router, entryPoints: ["websecure"], using: ["websecure"] };
        break;
      case "tls":
        routers[key] = { ...router, tls: {} };
        break;
      case "rule":
        routers[key] = { ...router, rule: 'Host("wrong.example.test")' };
        break;
      case "index":
        routers = Object.fromEntries(Object.entries(routers).filter(([name]) => name !== key));
        routers["route-demo%2Fapp-7-http@file"] = router;
        break;
      default:
        return mismatch satisfies never;
    }
    expect(acceptsAllRoutes({ ...graph, routers, services }, app, [route])).toBe(false);
  },
);

test("ignores unrelated routers and orphan resources but not stale owned routers", () => {
  const graph = graphFor();
  const router = graph.routers["route-demo%2Fapp-0-http@file"];
  if (router === undefined) throw new Error("router fixture missing");
  const unrelated = {
    ...graph,
    routers: { ...graph.routers, "route-demo%2Fapp-other-0-http@file": router, "dashboard@internal": {} },
    services: { ...graph.services, "orphan@file": {} },
    middlewares: { "orphan@file": {} },
  };
  expect(acceptsAllRoutes(unrelated, app, [route])).toBe(true);
  expect(
    acceptsAllRoutes(
      { ...unrelated, routers: { ...unrelated.routers, "route-demo%2Fapp-1-http@file": router } },
      app,
      [route],
    ),
  ).toBe(false);
});

test("preserves observer any-index semantics without accepting the wrong application index", () => {
  const graph = graphFor();
  const routers = Object.fromEntries(
    Object.entries(graph.routers).map(([name, router]) => [
      name.replace("-0-", "-7-"),
      { ...router, service: "route-demo%2Fapp-7" },
    ]),
  );
  const service = graph.services["route-demo%2Fapp-0@file"];
  if (service === undefined) throw new Error("service fixture missing");
  const shifted = { ...graph, routers, services: { "route-demo%2Fapp-7@file": service } };
  expect(matchesLiveRoute(shifted, app, { route, scheme: "http" })).toBe(true);
  expect(acceptsAllRoutes(shifted, app, [route])).toBe(false);
});
