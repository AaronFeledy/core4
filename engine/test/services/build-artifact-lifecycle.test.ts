import { expect, test } from "bun:test";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { BuildOrchestrator, StateStore } from "@lando/sdk/services";
import { makeTestRuntimeProvider } from "@lando/sdk/test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { openArtifactBuildResults } from "../../src/services/build-artifact-results.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeLayer, planWith, withTempRoots } from "./build-app-runner-test-support.ts";

const plan = planWith(
  { web: [{ id: "image", phase: "build", command: { command: ["echo", "image"] } }] },
  { web: { artifact: { kind: "ref", ref: "test/web@sha256:source", digest: "sha256:source" } } },
);

test.each(["complete", "fail", "interrupt"] as const)(
  "build %s settles its own claim and sweeps only after a non-interrupted exit",
  async (outcome) => {
    await withTempRoots(async () => {
      const store = makeTestStateStore();
      const base = makeTestRuntimeProvider();
      const bucket = await Effect.runPromise(openArtifactBuildResults(store.service));
      let swept = 0;
      let observedClaims = 0;
      const provider = {
        ...base,
        buildArtifact: (spec: Parameters<typeof base.buildArtifact>[0]) =>
          Effect.gen(function* () {
            const index = yield* bucket.get.pipe(Effect.orDie);
            observedClaims = index?.claims.length ?? 0;
            expect(index?.claims).toMatchObject([{ artifactRef: spec.ref, pid: process.pid }]);
            switch (outcome) {
              case "complete":
                return yield* base.buildArtifact(spec);
              case "fail":
                return yield* Effect.fail(
                  new ProviderInternalError({
                    providerId: base.id,
                    operation: "buildArtifact",
                    message: "injected failure",
                    remediation: "Retry.",
                  }),
                );
              case "interrupt":
                return yield* Effect.interrupt;
              default:
                return outcome satisfies never;
            }
          }),
        listArtifacts: () =>
          Effect.sync(() => {
            swept += 1;
            return [];
          }),
      };
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(BuildOrchestrator, (build) => build.build(plan)).pipe(
          Effect.provide(makeLayer(provider, store.layer)),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(outcome === "complete");
      expect(observedClaims).toBe(1);
      const index = await Effect.runPromise(bucket.get);
      expect(index?.claims).toEqual([]);
      expect(index?.results.map((result) => result.outcome)).toEqual(
        outcome === "interrupt" ? [] : [outcome],
      );
      expect(swept).toBe(outcome === "interrupt" ? 0 : 1);
    });
  },
);

test.each(["refresh", "build"] as const)(
  "%s claims an existing completed key; warm hits never sweep or dispatch",
  async (mode) => {
    await withTempRoots(async () => {
      const store = makeTestStateStore();
      const base = makeTestRuntimeProvider();
      const selectedPlan =
        mode === "refresh"
          ? plan
          : {
              ...plan,
              services: Object.fromEntries(
                Object.entries(plan.services).map(([name, service]) => [
                  name,
                  { ...service, pullPolicy: "build" as const },
                ]),
              ),
            };
      let calls = 0;
      let sweeps = 0;
      const provider = {
        ...base,
        buildArtifact: (spec: Parameters<typeof base.buildArtifact>[0]) =>
          Effect.gen(function* () {
            const bucket = yield* openArtifactBuildResults(store.service).pipe(Effect.orDie);
            const index = yield* bucket.get.pipe(Effect.orDie);
            expect(index?.claims).toHaveLength(1);
            if (calls === 1)
              expect(index?.results).toMatchObject([{ outcome: "complete", buildKey: spec.buildKey }]);
            calls += 1;
            return yield* base.buildArtifact(spec);
          }),
        listArtifacts: () =>
          Effect.sync(() => {
            sweeps += 1;
            return [];
          }),
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const build = yield* BuildOrchestrator;
          yield* build.build(selectedPlan);
          yield* build.build(selectedPlan, { refresh: mode === "refresh" });
          if (mode === "refresh") yield* build.build(selectedPlan);
        }).pipe(Effect.provide(makeLayer(provider, store.layer))),
      );
      expect(calls).toBe(2);
      expect(sweeps).toBe(2);
    });
  },
);

test("two concurrent same-key refreshes retain the sibling claim after one completes", async () => {
  await withTempRoots(async () => {
    const store = makeTestStateStore();
    const base = makeTestRuntimeProvider();
    const firstStarted = Deferred.makeUnsafe<void>();
    const bothStarted = Deferred.makeUnsafe<void>();
    const finishFirst = Deferred.makeUnsafe<void>();
    const finishSecond = Deferred.makeUnsafe<void>();
    let calls = 0;
    const provider = {
      ...base,
      buildArtifact: (spec: Parameters<typeof base.buildArtifact>[0]) =>
        Effect.gen(function* () {
          const position = ++calls;
          yield* Deferred.succeed(position === 1 ? firstStarted : bothStarted, undefined);
          yield* Deferred.await(position === 1 ? finishFirst : finishSecond);
          return yield* base.buildArtifact(spec);
        }),
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const build = yield* BuildOrchestrator;
          const bucket = yield* openArtifactBuildResults(yield* StateStore);
          const first = yield* build.build(plan, { refresh: true }).pipe(Effect.forkChild);
          yield* Deferred.await(firstStarted);
          const second = yield* build.build(plan, { refresh: true }).pipe(Effect.forkChild);
          yield* Deferred.await(bothStarted);
          const both = yield* bucket.get;
          yield* Deferred.succeed(finishFirst, undefined);
          yield* Fiber.join(first);
          const afterFirst = yield* bucket.get;
          yield* Deferred.succeed(finishSecond, undefined);
          yield* Fiber.join(second);
          return { both, afterFirst, settled: yield* bucket.get };
        }),
      ).pipe(Effect.provide(makeLayer(provider, store.layer)), Effect.timeout("5 seconds")),
    );
    expect(result.both?.claims).toHaveLength(2);
    expect(result.afterFirst?.claims.map((claim) => claim.id)).toEqual(
      result.both?.claims.slice(1).map((claim) => claim.id),
    );
    expect(result.afterFirst?.results).toMatchObject([{ outcome: "complete" }]);
    expect(result.settled?.claims).toEqual([]);
  });
});

test("another app reuses the same image while keeping separate owner results", async () => {
  await withTempRoots(async () => {
    const store = makeTestStateStore();
    const base = makeTestRuntimeProvider();
    let calls = 0;
    const provider = {
      ...base,
      buildArtifact: (spec: Parameters<typeof base.buildArtifact>[0]) =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(base.buildArtifact(spec))),
    };
    const other = { ...plan, id: AppId.make("other-app"), root: AbsolutePath.make("/tmp/other-app") };
    await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        yield* build.build(plan);
        yield* build.build(other);
      }).pipe(Effect.provide(makeLayer(provider, store.layer))),
    );
    const index = await Effect.runPromise(
      (await Effect.runPromise(openArtifactBuildResults(store.service))).get,
    );
    expect(calls).toBe(1);
    expect(index?.results.map((result) => result.owner)).toEqual([
      BuildOwner.fromPlan(plan).key,
      BuildOwner.fromPlan(other).key,
    ]);
  });
});

test("build-end in-use outcomes stay silent", async () => {
  await withTempRoots(async () => {
    const warnings = makeCommandWarnings(true);
    const base = makeTestRuntimeProvider();
    let removals = 0;
    const provider = {
      ...base,
      listArtifacts: (selector: Parameters<typeof base.listArtifacts>[0]) =>
        Effect.succeed([
          { id: "old", refs: [`lando-build-${selector.labels?.["dev.lando.build-store"]}-old`] },
        ]),
      removeArtifact: () =>
        Effect.sync(() => {
          removals += 1;
          return { kind: "in-use" as const, containers: ["web"], reason: "container uses image" };
        }),
    };
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (build) => build.build(plan)).pipe(
        Effect.provideService(CommandWarnings, warnings),
        Effect.provide(makeLayer(provider)),
      ),
    );
    expect(removals).toBe(1);
    expect(await Effect.runPromise(warnings.list)).toEqual([]);
  });
});
