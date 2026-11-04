import { expect, test } from "bun:test";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { Clock, Effect, Fiber } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import { dashboardConfigFile, routeFile } from "../src/proxy-paths.ts";
import { makeTraefikRouterService } from "../src/proxy.ts";
import { persistedRuntimeGraph } from "./apply-runtime-fixture.ts";
import { makeAckStore } from "./observe-routes-fixture.ts";
import { app, httpsRoutes } from "./proxy-tls-harness.ts";
import { makeAcceptanceFixture } from "./route-acceptance-fixture.ts";

const first = httpsRoutes[0];
if (first === undefined) throw new Error("route fixture missing");
const route = { ...first, scheme: "http" as const };

test("keeps changed generation mutation, restart, digest checks, live proof, and acknowledgement under one lock", async () => {
  const fixture = makeAcceptanceFixture("win32");
  const events: string[] = [];
  const store = makeAckStore(events);
  let locked = false;
  const stateStore: PluginStateStore = {
    ...store,
    withLock: (key, body, options) =>
      store.withLock(
        key,
        Effect.acquireUseRelease(
          Effect.sync(() => {
            locked = true;
          }),
          () => body,
          () =>
            Effect.sync(() => {
              locked = false;
            }),
        ),
        options,
      ),
  };
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    stateStore,
    fileSystem: {
      ...fixture.dependencies.fileSystem,
      readText: (path) =>
        Effect.sync(() => {
          if (path === routeFile(fixture.dependencies.paths, app)) events.push("snapshot");
        }).pipe(Effect.andThen(fixture.dependencies.fileSystem.readText(path))),
      writeAtomic: (path, content) =>
        Effect.sync(() => {
          expect(locked).toBe(true);
          if (path === routeFile(fixture.dependencies.paths, app)) events.push("write");
        }).pipe(Effect.andThen(fixture.dependencies.fileSystem.writeAtomic(path, content))),
    },
    globalApp: {
      ...fixture.dependencies.globalApp,
      restartRunningService: () =>
        Effect.sync(() => {
          expect(locked).toBe(true);
          events.push("restart");
          return true;
        }),
    },
    httpClient: HttpClient.make((request) =>
      Effect.sync(() => {
        expect(locked).toBe(true);
        events.push("live");
        return HttpClientResponse.fromWeb(request, Response.json(persistedRuntimeGraph(fixture.files)));
      }),
    ),
  });

  await Effect.runPromise(service.applyRoutes([route], app));

  expect(events).toEqual([
    "lock",
    "ack:remove",
    "write",
    "snapshot",
    "restart",
    "snapshot",
    "live",
    "snapshot",
    "ack:set",
  ]);
  expect(locked).toBe(false);
  expect(await Effect.runPromise(service.readAppliedRoutes(app))).toEqual([route]);
});

test("warm acknowledged generation still waits for live proof without restart or writes", async () => {
  const fixture = makeAcceptanceFixture("win32");
  const events: string[] = [];
  const stateStore = makeAckStore(events);
  let restarts = 0;
  const dependencies = {
    ...fixture.dependencies,
    stateStore,
    globalApp: {
      ...fixture.dependencies.globalApp,
      restartRunningService: () =>
        Effect.sync(() => {
          restarts++;
          return true;
        }),
    },
  };
  await Effect.runPromise(makeTraefikRouterService(dependencies).applyRoutes([route], app));
  fixture.runtime.setGraph({ routers: {}, services: {} });
  fixture.operations.length = 0;
  events.length = 0;
  const fresh = makeTraefikRouterService(dependencies);
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(fresh.applyRoutes([route], app));
      yield* TestClock.adjust(250);
      expect(yield* fresh.readAppliedRoutes(app)).toEqual([]);
      fixture.runtime.followPersisted();
      yield* TestClock.adjust(250);
      yield* Fiber.join(fiber);
      expect(yield* Clock.currentTimeMillis).toBe(500);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(restarts).toBe(1);
  expect(fixture.operations).toEqual([]);
  expect(events).toEqual(["lock"]);
});

test.each(["restart", "proof", "warm-proof"] as const)(
  "rejects digest changes during %s before acknowledgement",
  async (stage) => {
    const fixture = makeAcceptanceFixture("win32");
    const events: string[] = [];
    const stateStore = makeAckStore(events);
    const globalApp = {
      ...fixture.dependencies.globalApp,
      restartRunningService: () =>
        Effect.sync(() => {
          if (stage === "restart")
            fixture.files.set(dashboardConfigFile(fixture.dependencies.paths), "changed during restart");
          return true;
        }),
    };
    if (stage === "warm-proof") {
      await Effect.runPromise(
        makeTraefikRouterService({ ...fixture.dependencies, stateStore, globalApp }).applyRoutes(
          [route],
          app,
        ),
      );
      events.length = 0;
    }
    const service = makeTraefikRouterService({
      ...fixture.dependencies,
      stateStore,
      globalApp,
      httpClient: HttpClient.make((request) =>
        Effect.sync(() => {
          fixture.files.set(dashboardConfigFile(fixture.dependencies.paths), "changed during proof");
          return HttpClientResponse.fromWeb(request, Response.json(persistedRuntimeGraph(fixture.files)));
        }),
      ),
    });

    const result = await Effect.runPromise(service.applyRoutes([route], app).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError" } });
    expect(events).not.toContain("ack:set");
    expect(await Effect.runPromise(service.readAppliedRoutes(app))).toEqual([]);
  },
);

test("restart false cannot authorize a new acknowledgement even when runtime evidence matches", async () => {
  const fixture = makeAcceptanceFixture("win32");
  const events: string[] = [];
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    stateStore: makeAckStore(events),
    globalApp: { ...fixture.dependencies.globalApp, restartRunningService: () => Effect.succeed(false) },
  });

  const result = await Effect.runPromise(service.applyRoutes([route], app).pipe(Effect.result));

  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyApplyError" } });
  expect(events).not.toContain("ack:set");
  expect(fixture.runtime.requests).toEqual([]);
  expect(await Effect.runPromise(service.readAppliedRoutes(app))).toEqual([]);
});

test("interrupts a convergence delay without acknowledging or caching the generation", async () => {
  const fixture = makeAcceptanceFixture("win32");
  fixture.runtime.setGraph({ routers: {}, services: {} });
  const events: string[] = [];
  const service = makeTraefikRouterService({
    ...fixture.dependencies,
    stateStore: makeAckStore(events),
    globalApp: { ...fixture.dependencies.globalApp, restartRunningService: () => Effect.succeed(true) },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(service.applyRoutes([route], app));
      yield* TestClock.adjust(0);
      expect(fixture.runtime.requests).toHaveLength(1);
      yield* Fiber.interrupt(fiber);
      expect(yield* service.readAppliedRoutes(app)).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  expect(events).not.toContain("ack:set");
});
