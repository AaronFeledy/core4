import { expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import { FileSystem, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { openJournal } from "../../src/operations/accelerated-start-journal.ts";
import { prepareAppsGc } from "../../src/operations/apps-gc.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { acceleratedPlan, app, recoveryHarness } from "./accelerated-start-recovery-support.ts";
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

test("GC with volumes withholds prepared copy deletion before changing the app", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const fs = yield* FileSystem;
      const journal = yield* openJournal(app);
      return yield* Effect.gen(function* () {
        const prepared = yield* prepareAppsGc({ volumes: true });
        const report = yield* prepared.prune;
        const bucket = yield* openJournal(app);
        return { report, journal: yield* bucket.get };
      }).pipe(
        Effect.provideService(FileSystem, {
          ...fs,
          exists: (root) => (root === app.root ? Effect.succeed(false) : fs.exists(root)),
          readDir: (path) =>
            path === dirname(journal.path) ? Effect.succeed([basename(journal.path)]) : fs.readDir(path),
        }),
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          observeRuntime: Effect.succeed([
            {
              providerId: acceleratedPlan.provider,
              runtimeObserved: true,
              appliedPlans: [acceleratedPlan],
              services: [],
              volumes: [],
            },
          ]),
        }),
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer))),
  );
  expect(result.report.candidates[0]?.fileSyncCopiesRemovable).toBe(false);
  expect(result.report.roots).toMatchObject([
    {
      outcome: "failed",
      error: {
        _tag: "FileSyncStopError",
        message:
          "Lando cannot remove this provider's file-sync copies of a deleted app yet (lando). The copies are kept.",
        remediation:
          "Rerun without --volumes to remove everything else and keep the file-sync copies and their ownership journal.",
      },
    },
  ]);
  expect(harness.calls).toEqual([]);
  expect(result.journal).not.toBeNull();
});
