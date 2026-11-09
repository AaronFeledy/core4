import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { NoProviderInstalledError } from "@lando/sdk/errors";
import { AbsolutePath, SnapshotInfo, type VolumeInfo, appIdentityKey } from "@lando/sdk/schema";
import { DataMover, FileSystem, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect, Layer, Schema } from "effect";
import {
  acceleratedStartInventory,
  sweepCompletedAcceleratedStarts,
} from "../../src/operations/accelerated-start-inventory.ts";
import {
  beginOrResumeAcceleratedStart,
  openJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import { pendingStartBucketSpec } from "../../src/operations/accelerated-start-record.ts";
import { destroyAppAtRoot } from "../../src/operations/destroy.ts";
import { scanMissingAppRoots } from "../../src/operations/missing-app-roots.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { acceleratedPlan, app, recoveryHarness } from "./accelerated-start-recovery-support.ts";
import { emptySnapshots } from "./data-mover-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each([
  false,
  true,
  "journal-only",
  "foreign",
  "unavailable",
  "session-mismatch",
  "prepared-volume",
] as const)("missing-root journal preserves or removes verified targets: volumes=%s", async (volumes) => {
  const harness = await Effect.runPromise(
    recoveryHarness({
      ...(volumes === "unavailable" ? { engineOverrides: { isAvailable: Effect.succeed(false) } } : {}),
      ...(volumes === "session-mismatch" ? { extraSession: true } : {}),
    }),
  );
  const calls: string[] = [];
  const volume = {
    ref: { app: acceleratedPlan.id, store: "test-start-web-app-mount" },
    identity: {
      nativeName: "test-start-web-app-mount",
      coordinationKey: "key",
      generation: "nonce",
      ownerRoot: app.root,
      origin: "created",
    },
    labels: {
      "dev.lando.provider": volumes === "foreign" ? "foreign" : "lando",
      "dev.lando.sync.service": "web",
      "dev.lando.sync.mount-key": "app-mount",
    },
  } satisfies VolumeInfo;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const bucket = yield* openJournal(app);
      const record = yield* bucket.get;
      if (record === null) return yield* Effect.die("Missing journal fixture");
      const registry = yield* RuntimeProviderRegistry;
      const provider = yield* registry.select(acceleratedPlan);
      const { fileSyncTargets: _targets, ...genericCapabilities } = provider.capabilities;
      const fs = yield* FileSystem;
      yield* destroyAppAtRoot(app.root, {
        volumes: volumes !== false,
        yes: true,
      }).pipe(
        Effect.provideService(FileSystem, {
          ...fs,
          exists: (path) => (path === app.root ? Effect.succeed(false) : fs.exists(path)),
        }),
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          ...(volumes === "journal-only"
            ? {
                appliedPlansFor: () => Effect.succeed([]),
                resolveAppliedPlan: () => Effect.succeed(undefined),
                resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
              }
            : {}),
          select: () =>
            Effect.succeed({
              ...provider,
              id: "lando",
              capabilities: {
                ...genericCapabilities,
                ...(volumes === "prepared-volume" ? { fileSyncTargets: "prepared-volume" as const } : {}),
              },
              getStatus: Effect.sync(() => ({
                state: calls.includes("ready") ? ("running" as const) : ("idle" as const),
              })),
              ensureReady: Effect.sync(() => {
                calls.push("ready");
              }),
              listVolumes: () =>
                Effect.sync(() => {
                  if (!calls.includes("ready")) throw new Error("Volume preflight reached idle runtime");
                  return [volume];
                }),
              locateVolume: () =>
                Effect.succeed({
                  coordinationKey: "key",
                  nativeName: "test-start-web-app-mount",
                  presence: "present" as const,
                  identity: volume.identity,
                }),
              removeVolume: () =>
                Effect.sync(() => {
                  calls.push("remove-target");
                }),
            }),
        }),
      );
      return { journal: yield* bucket.get };
    }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer)), Effect.result),
  );
  if (typeof volumes === "string" && volumes !== "journal-only") {
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "FileSyncStopError" } });
    expect(harness.calls).toEqual([]);
    expect(calls).toEqual(["ready"]);
    if (volumes === "prepared-volume")
      expect(result).toMatchObject({
        failure: {
          message:
            "Lando cannot remove this provider's file-sync copies of a deleted app yet (lando). The copies are kept.",
          remediation:
            "Rerun without --volumes to remove everything else and keep the file-sync copies and their ownership journal.",
        },
      });
  } else {
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.journal === null).toBe(volumes !== false);
    expect(harness.calls).toEqual(
      volumes === "journal-only" ? ["terminate:old"] : ["terminate:old", `destroy:${volumes}`],
    );
    expect(calls).toEqual(volumes ? ["ready", "remove-target"] : ["ready"]);
  }
});

test("snapshot-only destroy prepares its idle owner before removing native snapshots", async () => {
  let preparations = 0;
  let removed = false;
  const harness = makeHarness({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    providerOverrides: {
      getStatus: Effect.sync(() => ({
        state: preparations === 0 ? ("idle" as const) : ("running" as const),
      })),
      ensureReady: Effect.sync(() => {
        preparations++;
      }),
    },
  });
  const snapshot = Schema.decodeUnknownSync(SnapshotInfo)({
    id: "owned",
    owner: { appRoot: app.root, ownerKey: appIdentityKey("owner", app.root) },
    store: { app: app.id, store: "database" },
    digest: "sha256:snapshot",
    sizeBytes: 1,
    createdAt: "2026-05-15T00:00:00Z",
    native: { provider: "lando", id: "owned", digest: "sha256:snapshot", sizeBytes: 1, format: "native" },
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* destroyAppAtRoot(app.root, { purgeSnapshots: true }).pipe(
        Effect.provideService(FileSystem, {
          ...fs,
          exists: (path) => (path === app.root ? Effect.succeed(false) : fs.exists(path)),
        }),
        Effect.provideService(DataMover, {
          ...emptySnapshots,
          listSnapshots: () => Effect.succeed([snapshot]),
          removeSnapshot: () =>
            Effect.sync(() => {
              if (preparations !== 1) throw new Error("Native snapshot removal needs one owner preparation");
              removed = true;
            }),
        }),
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer))),
  );
  expect(result.snapshotsRemoved).toBe(1);
  expect(removed).toBe(true);
  expect(preparations).toBe(1);
});

test.each([false, true, "unavailable"] as const)(
  "disk journals expose copy removability and completed documents are swept: %s",
  async (prepared) => {
    const root = await mkdtemp(join(tmpdir(), "lando-journal-inventory-"));
    try {
      const appRoot = AbsolutePath.make(join(root, "app"));
      await mkdir(appRoot);
      const ref = { ...app, root: appRoot };
      const plan = {
        ...acceleratedPlan,
        root: appRoot,
        services: Object.fromEntries(
          Object.entries(acceleratedPlan.services).map(([name, service]) => [
            name,
            {
              ...service,
              mounts: service.mounts.map((mount) =>
                mount.type === "bind" ? { ...mount, source: appRoot } : mount,
              ),
            },
          ]),
        ),
        fileSync: acceleratedPlan.fileSync.map((entry) => ({
          ...entry,
          session: { ...entry.session, app: ref, source: appRoot },
        })),
      };
      const paths = makeLandoPaths({ userDataRoot: join(root, "state") });
      const otherRoot = AbsolutePath.make(join(root, "other"));
      const layer = Layer.mergeAll(
        DiskStateStore.layerAt(paths.roots),
        BunFileSystem.layer,
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([acceleratedPlan.provider]),
          select: () =>
            prepared === "unavailable"
              ? Effect.fail(new NoProviderInstalledError({ message: "Journal provider is unavailable." }))
              : Effect.succeed({
                  ...TestRuntimeProvider,
                  capabilities: {
                    ...TestRuntimeProvider.capabilities,
                    ...(prepared === true ? { fileSyncTargets: "prepared-volume" as const } : {}),
                  },
                }),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          ...(prepared === "unavailable"
            ? {
                observeRuntime: Effect.succeed([
                  {
                    providerId: plan.provider,
                    runtimeObserved: false,
                    appliedPlans: [
                      { ...plan, root: otherRoot, identity: { appRoot: otherRoot, ownerKey: "other" } },
                    ],
                    services: [],
                    volumes: [],
                  },
                ]),
              }
            : {}),
        }),
      );
      const settled = await Effect.runPromise(
        beginOrResumeAcceleratedStart(plan, ref).pipe(Effect.provide(layer)),
      );
      const stored = (await Effect.runPromise(acceleratedStartInventory.pipe(Effect.provide(layer))))
        .records[0];
      if (stored === undefined) throw new Error("Expected a journal file");
      await Effect.runPromise(settled.advance("record-sessions"));
      await Effect.runPromise(settled.advance("record-apply-intent"));
      await Effect.runPromise(settled.complete);
      await Effect.runPromise(settled.complete);
      expect(await Bun.file(stored.path).exists()).toBe(false);
      const attempt = await Effect.runPromise(
        beginOrResumeAcceleratedStart(plan, ref).pipe(Effect.provide(layer)),
      );
      const inventory = await Effect.runPromise(scanMissingAppRoots().pipe(Effect.provide(layer)));
      expect(inventory.candidates.map((candidate) => candidate.root)).toEqual(
        prepared === "unavailable" ? [otherRoot] : [],
      );
      expect(inventory.scans).toMatchObject([{ recordedState: true, runtimeObserved: false }]);
      await rm(appRoot, { recursive: true });
      const missing = await Effect.runPromise(scanMissingAppRoots().pipe(Effect.provide(layer)));
      const roots = missing.candidates;
      expect(roots).toHaveLength(prepared === "unavailable" ? 2 : 1);
      expect(roots.find((candidate) => candidate.root === appRoot)).toMatchObject({
        root: appRoot,
        journals: [attempt.record],
        fileSyncCopiesRemovable: !prepared,
      });
      if (prepared === "unavailable")
        expect(missing.scans).toMatchObject([
          { errorTag: "NoProviderInstalledError", recordedState: true, complete: false },
        ]);
      const journal = (await Effect.runPromise(acceleratedStartInventory.pipe(Effect.provide(layer))))
        .records[0];
      if (journal === undefined) throw new Error("Expected an open journal");
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* StateStore;
          const bucket = yield* store.open(pendingStartBucketSpec(basename(journal.path)));
          yield* bucket.set({ ...attempt.record, phase: "completed" });
        }).pipe(Effect.provide(layer)),
      );
      expect(await Effect.runPromise(sweepCompletedAcceleratedStarts().pipe(Effect.provide(layer)))).toEqual({
        removed: 1,
        unreadable: [],
      });
      expect(await Bun.file(journal.path).exists()).toBe(false);
      expect(await Effect.runPromise(sweepCompletedAcceleratedStarts().pipe(Effect.provide(layer)))).toEqual({
        removed: 0,
        unreadable: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
