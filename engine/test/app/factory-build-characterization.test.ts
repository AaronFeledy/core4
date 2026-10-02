import { expect, test } from "bun:test";
import type { App } from "@lando/sdk/app";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { Context, DateTime, Effect, Layer } from "effect";
import { type AppHandleRuntimeServices, makeAppHandle } from "../../src/app/handle.ts";
import { type AppLifecycle, makeAppLifecycle } from "../../src/app/lifecycle.ts";
import { appOperations } from "../../src/app/operations.ts";

class Lifecycle extends Context.Service<Lifecycle, AppLifecycle>()("app-factory-build-test/Lifecycle") {}
class Handle extends Context.Service<Handle, App>()("app-factory-build-test/Handle") {}

const characterizeBuilds = async <R, S, E>(
  layer: Layer.Layer<R>,
  read: Effect.Effect<S, E, R>,
  builds: () => number,
) => {
  const graph = Layer.merge(layer, layer);
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* read;
      expect(yield* read).toBe(outer);
      expect(builds()).toBe(1);
      const nested = yield* read.pipe(Effect.provide(graph));
      expect(builds()).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* read).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(read.pipe(Effect.provide(graph)));
  expect(builds()).toBe(2);
  expect(fresh).not.toBe(outer);
};

test("the real lifecycle factory constructs once per runtime behind a test-only layer", async () => {
  // Given: lifecycle is a factory, not a production Layer; the adapter supplies its owning scope.
  const instances: AppLifecycle[] = [];
  const layer = Layer.effect(
    Lifecycle,
    Effect.gen(function* () {
      const lifecycle = yield* makeAppLifecycle(yield* Effect.scope);
      instances.push(lifecycle);
      return lifecycle;
    }),
  );

  // When: memoization boundaries drive the actual constructor through the adapter.
  await characterizeBuilds(layer, Lifecycle, () => instances.length);

  // Then: one construction per run; the nested provide reuses the parent's build.
  expect(instances).toHaveLength(2);
  expect(new Set(instances).size).toBe(2);
});

test("the real handle factory constructs once per runtime behind a test-only layer", async () => {
  // Given: only the handle's pure plan surface is used, so its captured runtime needs no services.
  const runtime = Context.makeUnsafe<AppHandleRuntimeServices>(new Map());
  const plan: AppPlan = {
    id: AppId.make("factory-characterization"),
    name: "factory-characterization",
    slug: "factory-characterization",
    root: AbsolutePath.make("/app-factory-characterization"),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
    extensions: {},
  };
  const instances: App[] = [];
  const layer = Layer.effect(
    Handle,
    Effect.gen(function* () {
      const lifecycle = yield* makeAppLifecycle(yield* Effect.scope);
      const handle = makeAppHandle(
        { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
        runtime,
        appOperations,
        lifecycle,
      );
      instances.push(handle);
      return handle;
    }),
  );
  const read = Handle.pipe(
    Effect.tap((handle) =>
      handle.plan.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            expect(value).toBe(plan);
          }),
        ),
      ),
    ),
  );

  // When: the same test adapter is composed twice, nested, then supplied in a fresh run.
  await characterizeBuilds(layer, read, () => instances.length);

  // Then: count actual makeAppHandle results, not adapter evaluations or fake handle objects.
  expect(instances).toHaveLength(2);
  expect(new Set(instances).size).toBe(2);
});
