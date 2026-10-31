import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ServiceName,
  type SnapshotInfo,
  type VolumeIdentity,
} from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Cause, DateTime, Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";

import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import {
  type SqliteHelperContext,
  type SqliteHelperDeps,
  prepareSqliteHelper,
  withSqliteHelper,
} from "../src/sqlite-helper.ts";
import { requireSameSqliteTarget, resolveSqliteTargetIdentity } from "../src/sqlite-identity.ts";
import { coveringSqliteMount, sqliteHelperAccess } from "../src/sqlite-mount.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteRetentionSelection } from "../src/sqlite-retention.ts";
import {
  type SqliteSnapshotDeps,
  persistSqliteSnapshot,
  sqliteSnapshotsCompatible,
} from "../src/sqlite-snapshot.ts";
import type { SqlPlanService } from "../src/views.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

const roots: string[] = [];
afterEach(() => {
  cleanupSqlTestDeps();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-sqlite-target-"));
  roots.push(root);
  const applied = {
    id: "app",
    provider: "docker",
    root: AbsolutePath.make(root),
    identity: { appRoot: AbsolutePath.make(root), ownerKey: "owner" },
  } as AppPlan;
  const target = {
    kind: "file",
    name: "appserver",
    type: "php:8.3",
    family: "sqlite",
    path: "data/site.sqlite",
  } as const;
  const deps: SqliteHelperDeps = {
    applied,
    run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
    pullArtifact: () => Effect.succeed({}),
    paths: { ownerSnapshotsDir: () => root },
  };
  const bind: SqliteHelperContext = {
    dbPath: "/app/data/site.sqlite",
    covering: { kind: "bind", source: root, target: "/app", readOnly: false },
    scratchHost: root,
    scratchTarget: "/scratch",
    user: "100:200",
    spec: { image: "sqlite-helper", binds: [] },
  };
  const volumeIdentity: VolumeIdentity = {
    coordinationKey: '["daemon-a","shared-data"]',
    nativeName: "shared-data",
    generation: "generation-a",
    ownerRoot: AbsolutePath.make(root),
    origin: "created",
  };
  const volume: SqliteHelperContext = {
    ...bind,
    covering: {
      kind: "volume",
      store: "shared-data",
      target: "/app/data",
      readOnly: false,
      subpath: "tenant-a",
    },
    volumeIdentity,
  };
  return { root, applied, target, deps, bind, volume, volumeIdentity };
};

describe("SQLite physical target identity", () => {
  test("canonicalizes bind aliases and distinguishes a changed source directory", async () => {
    const f = fixture();
    const alias = join(f.root, "alias");
    symlinkSync(f.root, alias);
    const other = join(f.root, "other-source");
    mkdirSync(other);
    const original = await Effect.runPromise(resolveSqliteTargetIdentity(f.deps, f.bind, f.target));
    const aliasIdentity = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        f.deps,
        { ...f.bind, covering: { kind: "bind", source: alias, target: "/app", readOnly: false } },
        f.target,
      ),
    );
    const changed = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        f.deps,
        { ...f.bind, covering: { kind: "bind", source: other, target: "/app", readOnly: false } },
        f.target,
      ),
    );
    expect(aliasIdentity).toBe(original);
    expect(changed).not.toBe(original);
    const mismatch = await Effect.runPromiseExit(requireSameSqliteTarget(original, changed, f.target.name));
    expect(Exit.isFailure(mismatch)).toBe(true);
  });

  test("bind identity includes the selected database and provider", async () => {
    const f = fixture();
    const original = await Effect.runPromise(resolveSqliteTargetIdentity(f.deps, f.bind, f.target));
    const otherDatabase = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        f.deps,
        { ...f.bind, dbPath: "/app/data/other.sqlite" },
        { ...f.target, path: "data/other.sqlite" },
      ),
    );
    const otherProvider = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        { ...f.deps, applied: { ...f.applied, provider: "lando" as AppPlan["provider"] } },
        f.bind,
        f.target,
      ),
    );
    expect(otherDatabase).not.toBe(original);
    expect(otherProvider).not.toBe(original);
  });

  test("distinguishes volume generation, daemon, owner, native volume, and subpath", async () => {
    const f = fixture();
    const original = await Effect.runPromise(resolveSqliteTargetIdentity(f.deps, f.volume, f.target));
    for (const identity of [
      { ...f.volumeIdentity, generation: "generation-b" },
      { ...f.volumeIdentity, coordinationKey: '["daemon-b","shared-data"]' },
      { ...f.volumeIdentity, ownerRoot: AbsolutePath.make("/other-owner") },
      { ...f.volumeIdentity, nativeName: "other-volume" },
    ]) {
      const changed = await Effect.runPromise(
        resolveSqliteTargetIdentity(f.deps, { ...f.volume, volumeIdentity: identity }, f.target),
      );
      expect(changed).not.toBe(original);
    }
    const otherSubpath = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        f.deps,
        {
          ...f.volume,
          covering: {
            kind: "volume",
            store: "shared-data",
            target: "/app/data",
            readOnly: false,
            subpath: "tenant-b",
          },
        },
        f.target,
      ),
    );
    expect(otherSubpath).not.toBe(original);
    const { volumeIdentity: _volumeIdentity, ...unproven } = f.volume;
    const missing = await Effect.runPromiseExit(resolveSqliteTargetIdentity(f.deps, unproven, f.target));
    expect(Exit.isFailure(missing)).toBe(true);
  });

  test("forwards the deepest volume subpath to both inspection and mutation mounts", () => {
    const f = fixture();
    const service: SqlPlanService = {
      name: "appserver",
      type: "php:8.3",
      environment: {},
      storage: [],
      mounts: [
        { type: "bind", source: f.root, target: "/app", readOnly: false, role: "app" },
        { type: "volume", store: "shared-data", target: "/app/data", readOnly: false, subpath: "tenant-a" },
      ],
    };
    const covering = coveringSqliteMount(service, f.bind.dbPath);
    expect(covering).toEqual(f.volume.covering);
    if (covering?.kind !== "volume") throw new Error("Expected named-volume covering mount");
    for (const readOnly of [true, false]) {
      const access = sqliteHelperAccess({ ...covering, readOnly }, f.applied);
      expect(access.mounts?.[0]).toMatchObject({ store: "shared-data", subpath: "tenant-a", readOnly });
    }
  });

  test("rejects accelerated or privately copied covering binds before image acquisition or helper execution", async () => {
    const f = fixture();
    let pulls = 0;
    let runs = 0;
    const deps = {
      ...f.deps,
      pullArtifact: () => {
        pulls++;
        return Effect.succeed({});
      },
      run: () => {
        runs++;
        return Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" });
      },
    };
    for (const metadata of [
      { realization: "accelerated" as const },
      { realization: "passthrough" as const, mountKey: "app-mount" },
      { fileMode: 0o600 },
    ]) {
      const service: SqlPlanService = {
        name: "appserver",
        type: "php:8.3",
        environment: {},
        storage: [],
        mounts: [{ type: "bind", source: f.root, target: "/app", role: "app", readOnly: false, ...metadata }],
      };
      const exit = await Effect.runPromiseExit(prepareSqliteHelper(deps, service, f.target));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          SqlRecoveryUnavailableError,
        );
    }
    expect(pulls).toBe(0);
    expect(runs).toBe(0);
  });

  test("rejects path-only legacy snapshots and snapshots from another physical target", async () => {
    const f = fixture();
    const targetIdentity = await Effect.runPromise(resolveSqliteTargetIdentity(f.deps, f.volume, f.target));
    const source: SnapshotInfo = {
      owner: { appRoot: AbsolutePath.make(f.root), ownerKey: "owner" },
      id: "snapshot",
      store: { app: f.applied.id, store: sqliteSnapshotStore(f.target.path) },
      digest: "a".repeat(64),
      sizeBytes: 2048,
      createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      format: "tar",
      metadata: {
        service: ServiceName.make("appserver"),
        volumeInstanceId: targetIdentity,
        family: "sqlite",
        version: "3.54.1",
        imageIdentity: "sqlite",
        recoveryReason: "manual",
      },
    };
    const context = {
      ownerKey: "owner",
      appRoot: f.root,
      service: "appserver",
      path: f.target.path,
      version: "3.54.1",
      targetIdentity,
    };
    expect(sqliteSnapshotsCompatible(source, context)).toBe(true);
    if (source.metadata === undefined) throw new Error("Expected snapshot metadata");
    expect(
      sqliteSnapshotsCompatible(
        { ...source, metadata: { ...source.metadata, volumeInstanceId: f.target.path } },
        context,
      ),
    ).toBe(false);
    const otherIdentity = await Effect.runPromise(
      resolveSqliteTargetIdentity(
        f.deps,
        { ...f.volume, volumeIdentity: { ...f.volumeIdentity, generation: "replacement" } },
        f.target,
      ),
    );
    expect(sqliteSnapshotsCompatible(source, { ...context, targetIdentity: otherIdentity })).toBe(false);
  });
});

describe("SQLite target retention with the real DataMover catalog", () => {
  for (const recovery of [true, false]) {
    test(`${recovery ? "automatic" : "manual"} retention preserves other physical targets in the same app/path bucket`, async () => {
      const fixture = await makeRetentionTestDeps();
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const store = sqliteSnapshotStore("data/site.sqlite");
          const filter = { app: AppId.make("sql-app"), store, service: ServiceName.make("database") };
          const paths = makeLandoPaths({
            userConfRoot: join(fixture.harness.root, "conf"),
            userDataRoot: join(fixture.harness.root, "data"),
            userCacheRoot: join(fixture.harness.root, "cache"),
            env: {},
          });
          const stateStore = yield* StateStore.pipe(Effect.provide(DiskStateStore.layer));
          const deps = {
            paths: { ownerSnapshotsDir: paths.ownerSnapshotsDir },
            stateStore,
          } as unknown as SqliteSnapshotDeps;
          const payload = join(fixture.harness.root, "retention-payload.sqlite");
          writeFileSync(payload, "SQLite format 3\0retention fixture");
          const target = {
            kind: "file",
            name: "database",
            type: "php:8.3",
            family: "sqlite",
            path: "data/site.sqlite",
          } as const;
          let time = 1000;
          const seed = (targetIdentity: string, reason: "manual" | "reset") =>
            Effect.gen(function* () {
              yield* TestClock.setTime(time++);
              return (yield* persistSqliteSnapshot(deps, fixture.deps.plan, target, payload, "3.54.1", {
                targetIdentity,
                recoveryReason: reason,
              })).id;
            });
          const foreign = yield* seed("other-physical-target", recovery ? "reset" : "manual");
          const matching: string[] = [];
          for (let index = 0; index < 5; index++)
            matching.push(yield* seed("selected-target", recovery ? "reset" : "manual"));
          const oppositeClass = yield* seed("selected-target", recovery ? "manual" : "reset");
          const snapshots = yield* fixture.mover.listSnapshots(filter);
          const selection = sqliteRetentionSelection(
            snapshots,
            "selected-target",
            3,
            recovery,
            recovery ? [matching[4] ?? "", oppositeClass] : [],
          );
          const removed = yield* fixture.mover.pruneSnapshots({
            filter,
            recovery,
            keepLatest: selection.keepLatest,
            retainSnapshotIds: selection.retainSnapshotIds,
          });
          const remaining = yield* fixture.mover.listSnapshots(filter);
          return {
            matching,
            foreign,
            oppositeClass,
            removed,
            remaining,
            candidates: selection.candidates.map((snapshot) => snapshot.id),
          };
        }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
      );
      expect([...outcome.removed].sort()).toEqual(outcome.matching.slice(0, 2).sort());
      expect(outcome.candidates.sort()).toEqual(outcome.matching.slice(0, 2).sort());
      expect(outcome.remaining.map((snapshot) => snapshot.id).sort()).toEqual(
        [outcome.foreign, outcome.oppositeClass, ...outcome.matching.slice(2)].sort(),
      );
    });
  }
});

test("manual prune preserves snapshots created during confirmation and applies under the SQLite lock", async () => {
  const f = await makeRetentionTestDeps();
  const outcome = await Effect.runPromise(
    Effect.gen(function* () {
      const paths = makeLandoPaths({
        userConfRoot: join(f.harness.root, "conf"),
        userDataRoot: join(f.harness.root, "data"),
        userCacheRoot: join(f.harness.root, "cache"),
        env: {},
      });
      const originalStore = yield* StateStore.pipe(Effect.provide(DiskStateStore.layer));
      let locked = false;
      const stateStore = {
        ...originalStore,
        withLock: <A, E>(key: string, body: Effect.Effect<A, E>) =>
          originalStore.withLock(
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
          ),
      };
      const target = {
        kind: "file",
        name: "database",
        type: "php:8.3",
        family: "sqlite",
        path: "data/site.sqlite",
      } as const;
      const service: SqlPlanService = {
        name: "database",
        type: "php:8.3",
        environment: {},
        storage: [],
        mounts: [{ type: "bind", source: f.harness.root, target: "/app", role: "app", readOnly: false }],
      };
      const applied = {
        id: AppId.make(f.deps.plan.id),
        root: AbsolutePath.make(f.harness.root),
        provider: "test",
        identity: f.deps.plan.identity,
      } as AppPlan;
      const sqlite: SqliteSnapshotDeps = {
        applied,
        stateStore,
        paths: { ownerSnapshotsDir: paths.ownerSnapshotsDir },
        pullArtifact: () => Effect.succeed({}),
        run: () => Effect.succeed({ exitCode: 0, stdout: "100:200\n", stderr: "" }),
      };
      const targetIdentity = yield* withSqliteHelper(sqlite, service, target, (helper) =>
        resolveSqliteTargetIdentity(sqlite, helper, target),
      );
      const payload = join(f.harness.root, "prune-payload.sqlite");
      writeFileSync(payload, "SQLite format 3\0prune fixture");
      let time = 1000;
      const seed = (identity: string) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(time++);
          return (yield* persistSqliteSnapshot(sqlite, f.deps.plan, target, payload, "3.54.1", {
            targetIdentity: identity,
            recoveryReason: "manual",
          })).id;
        });
      const original: string[] = [];
      for (let index = 0; index < 3; index++) original.push(yield* seed(targetIdentity));
      let newForeign = "";
      let newCurrent = "";
      let confirmations = 0;
      const result = yield* executeSqliteCommand(
        {
          ...f.deps,
          plan: { ...f.deps.plan, services: { database: service } },
          sqlite,
          confirm: () =>
            Effect.gen(function* () {
              confirmations++;
              expect(locked).toBe(false);
              newForeign = yield* seed("different-physical-target");
              newCurrent = yield* seed(targetIdentity);
              return true;
            }),
          pruneSnapshots: (policy) =>
            Effect.gen(function* () {
              expect(locked).toBe(true);
              return yield* f.mover.pruneSnapshots(policy);
            }),
        },
        { action: "prune", yes: false, keepLatest: 1 },
        target,
      );
      const remaining = yield* f.mover.listSnapshots({
        app: AppId.make(f.deps.plan.id),
        store: sqliteSnapshotStore(target.path),
        service: ServiceName.make(target.name),
      });
      return { result, remaining, original, newForeign, newCurrent, confirmations };
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
  expect(outcome.confirmations).toBe(1);
  expect([...(outcome.result.prunedSnapshotIds ?? [])].sort()).toEqual(outcome.original.slice(0, 2).sort());
  expect(outcome.remaining.map((snapshot) => snapshot.id).sort()).toEqual(
    [outcome.original[2] ?? "", outcome.newForeign, outcome.newCurrent].sort(),
  );
});
