import { describe, expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { ProviderId, ServiceName } from "@lando/sdk/schema";
import { BuildOrchestrator, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { BuildOrchestratorLive, withBuildProvider } from "../../src/services/build-orchestrator.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { planWith } from "./build-app-runner-test-support.ts";

const plan = planWith({ web: [] });
const provider = (id: string) => ({
  ...TestRuntimeProvider,
  id,
  capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
  pullArtifact: () => Effect.succeed({ providerId: ProviderId.make(id), ref: `image:${id}` }),
});

const makeLayer = (selected: string[]) => {
  const fallback = provider("registry");
  const dependencies = Layer.mergeAll(
    EventServiceLive,
    makeTestStateStore().layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([plan.provider]),
      capabilities: Effect.succeed(fallback.capabilities),
      select: () =>
        Effect.sync(() => {
          selected.push("registry");
          return fallback;
        }),
    }),
  );
  return BuildOrchestratorLive.pipe(Layer.provide(dependencies));
};

const buildRef = Effect.flatMap(BuildOrchestrator, (build) => build.build(plan)).pipe(
  Effect.map((built) => built.services[ServiceName.make("web")]?.artifact),
);

describe("build provider fiber-local selection", () => {
  test("uses the registry outside bindings and restores it after a bound build", async () => {
    // Given
    const selected: string[] = [];
    // When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* buildRef;
        const inside = yield* withBuildProvider(buildRef, provider("bound"));
        const after = yield* buildRef;
        return { before, inside, after };
      }).pipe(Effect.provide(makeLayer(selected))),
    );
    // Then
    expect(results).toEqual({
      before: { kind: "ref", ref: "image:registry" },
      inside: { kind: "ref", ref: "image:bound" },
      after: { kind: "ref", ref: "image:registry" },
    });
    expect(selected).toEqual(["registry", "registry"]);
  });

  test("inherits the selected provider in a forked child and restores a nested override", async () => {
    // Given
    const selected: string[] = [];
    // When
    const results = await Effect.runPromise(
      withBuildProvider(
        Effect.gen(function* () {
          const child = yield* Effect.fork(buildRef);
          const nested = yield* withBuildProvider(buildRef, provider("nested"));
          return [yield* Fiber.join(child), nested, yield* buildRef];
        }),
        provider("parent"),
      ).pipe(Effect.provide(makeLayer(selected))),
    );
    // Then
    expect(results).toEqual([
      { kind: "ref", ref: "image:parent" },
      { kind: "ref", ref: "image:nested" },
      { kind: "ref", ref: "image:parent" },
    ]);
    expect(selected).toEqual([]);
  });

  test("keeps overlapping sibling provider bindings separate", async () => {
    // Given
    const selected: string[] = [];
    // When
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const leftReady = yield* Deferred.make<void>();
        const rightReady = yield* Deferred.make<void>();
        return yield* Effect.all(
          [
            withBuildProvider(
              Deferred.succeed(leftReady, undefined).pipe(
                Effect.zipRight(Deferred.await(rightReady)),
                Effect.zipRight(buildRef),
              ),
              provider("left"),
            ),
            withBuildProvider(
              Deferred.succeed(rightReady, undefined).pipe(
                Effect.zipRight(Deferred.await(leftReady)),
                Effect.zipRight(buildRef),
              ),
              provider("right"),
            ),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(makeLayer(selected))),
    );
    // Then
    expect(results).toEqual([
      { kind: "ref", ref: "image:left" },
      { kind: "ref", ref: "image:right" },
    ]);
    expect(selected).toEqual([]);
  });

  test("buildApp also consults the dynamic binding rather than the registry", async () => {
    // Given
    const selected: string[] = [];
    const buildApp = Effect.flatMap(BuildOrchestrator, (build) => build.buildApp(plan));
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* buildApp;
        yield* withBuildProvider(buildApp, provider("bound"));
        yield* buildApp;
      }).pipe(Effect.provide(makeLayer(selected))),
    );
    // Then
    expect(selected).toEqual(["registry", "registry"]);
  });
});
