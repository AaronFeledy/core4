import { expect, test } from "bun:test";
import type { App } from "@lando/sdk/app";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { Context, DateTime, Effect, Layer, Runtime } from "effect";
import { type AppHandleRuntimeServices, makeAppHandle } from "../../src/app/handle.ts";
import { type AppLifecycle, makeAppLifecycle } from "../../src/app/lifecycle.ts";
import { appOperations } from "../../src/app/operations.ts";

class Lifecycle extends Context.Tag("app-factory-build-test/Lifecycle")<Lifecycle, AppLifecycle>() {}
class Handle extends Context.Tag("app-factory-build-test/Handle")<Handle, App>() {}

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
      expect(builds()).toBe(2);
      expect(nested).not.toBe(outer);
      expect(yield* read).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(read.pipe(Effect.provide(graph)));
  expect(builds()).toBe(3);
  expect(fresh).not.toBe(outer);
};

test("the real lifecycle factory constructs at counts 1, 2, 3 behind a test-only layer", async () => {
  // Given: lifecycle is a factory, not a production Layer; the adapter supplies its owning scope.
  const instances: AppLifecycle[] = [];
  const layer = Layer.scoped(
    Lifecycle,
    Effect.gen(function* () {
      const lifecycle = yield* makeAppLifecycle(yield* Effect.scope);
      instances.push(lifecycle);
      return lifecycle;
    }),
  );

  // When: memoization boundaries drive the actual constructor through the adapter.
  await characterizeBuilds(layer, Lifecycle, () => instances.length);

  // Then: one construction per graph, another for nested provide, another for the fresh run.
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
});

test("the real handle factory constructs at counts 1, 2, 3 behind a test-only layer", async () => {
  // Given: only the handle's pure plan surface is used, so its captured runtime needs no services.
  const runtime = Runtime.make({
    ...Runtime.defaultRuntime,
    context: Context.unsafeMake<AppHandleRuntimeServices>(new Map()),
  });
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
    metadata: { resolvedAt: DateTime.unsafeMake(0), source: "test", runtime: 4 },
    extensions: {},
  };
  const instances: App[] = [];
  const layer = Layer.scoped(
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
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
});
