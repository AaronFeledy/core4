import { expect, test } from "bun:test";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { prepareAppsGc } from "../../src/operations/apps-gc.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("GC reports attempted cleanup and unverified completion when its owner becomes unobservable", async () => {
  let destroyed = false;
  const harness = makeHarness({
    onDestroy: () => {
      destroyed = true;
    },
    resolveAppliedPlan: () => Effect.succeed(destroyed ? undefined : plan),
  });
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const fs = yield* FileSystem;
      return yield* Effect.gen(function* () {
        const prepared = yield* prepareAppsGc();
        return yield* prepared.prune;
      }).pipe(
        Effect.provideService(FileSystem, {
          ...fs,
          exists: (path) => (path === plan.root ? Effect.succeed(false) : fs.exists(path)),
        }),
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          observeRuntime: Effect.sync(() => [
            {
              providerId: plan.provider,
              runtimeObserved: !destroyed,
              appliedPlans: destroyed ? [] : [plan],
              services: [],
              volumes: [],
            },
          ]),
        }),
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer))),
  );

  expect(destroyed).toBe(true);
  expect(report.roots).toMatchObject([{ outcome: "retained", confirmed: true }]);
  expect(report.scans).toMatchObject([{ complete: false, runtimeObserved: false }]);
});
