import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ServiceName,
  type SnapshotFilter,
  type SnapshotHandle,
  SnapshotInfo,
  appIdentityKey,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";

import type { SqlCommandDeps } from "../src/command-types.ts";
import { executeSqliteCommand } from "../src/sqlite-execute.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteManualPruneSelection } from "../src/sqlite-retention.ts";
import type { SqliteSnapshotDeps } from "../src/sqlite-snapshot.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

const setup = () => {
  const harness = makeSqlTestDeps({ password: "unused" });
  const root = harness.root;
  const sourceRoot = join(root, "source-worktree");
  mkdirSync(sourceRoot);
  const target = {
    kind: "file",
    name: "database",
    type: "php:8.3",
    family: "sqlite",
    path: "data/missing.sqlite",
  } as const;
  const store = sqliteSnapshotStore(target.path);
  const catalog: SnapshotInfo[] = [];
  let order = 0;
  const snapshot = (
    id: string,
    options: {
      root?: string;
      app?: string;
      repoGroupKey?: string;
      store?: string;
      service?: string;
      descriptor?: string;
      family?: string;
      reason?: "manual" | "reset";
    } = {},
  ) =>
    SnapshotInfo.make({
      id,
      owner: {
        appRoot: AbsolutePath.make(options.root ?? sourceRoot),
        ownerKey: appIdentityKey("owner", options.root ?? sourceRoot),
        repoGroupKey: options.repoGroupKey ?? "shared-repository",
      },
      store: { app: AppId.make(options.app ?? "source-app"), store: options.store ?? store },
      digest: `digest:${id}`,
      sizeBytes: 2048,
      createdAt: DateTime.makeUnsafe(`2026-01-01T00:00:${String(order++).padStart(2, "0")}Z`),
      format: "tar",
      metadata: {
        service: ServiceName.make(options.service ?? target.name),
        volumeInstanceId: options.descriptor ?? "physical-a",
        family: options.family ?? "sqlite",
        version: "3.54.1",
        imageIdentity: "sqlite",
        recoveryReason: options.reason ?? "manual",
      },
    });
  catalog.push(
    snapshot("a-old"),
    snapshot("a-new"),
    snapshot("b-old", { descriptor: "physical-b" }),
    snapshot("b-new", { descriptor: "physical-b" }),
    snapshot("automatic", { reason: "reset" }),
    snapshot("postgres", { family: "postgres" }),
    snapshot("other-service", { service: "another-service" }),
    snapshot("other-repository", {
      root: join(root, "foreign-repository"),
      repoGroupKey: "other-repository",
    }),
    snapshot("shared-app-other-owner", { root: join(root, "other-worktree") }),
    snapshot("renamed-app-same-owner", { app: "renamed-source" }),
    snapshot("local", { root, app: harness.deps.plan.id }),
  );
  let helperCalls = 0;
  let imageCalls = 0;
  let locked = false;
  const removed: SnapshotHandle[] = [];
  const observedFilters: SnapshotFilter[] = [];
  const ownerIdentity = {
    appRoot: AbsolutePath.make(root),
    ownerKey: appIdentityKey("owner", root),
    repoGroupKey: "shared-repository",
  };
  const applied = {
    id: AppId.make(harness.deps.plan.id),
    root: AbsolutePath.make(root),
    provider: "test",
    identity: ownerIdentity,
  } as AppPlan;
  const sqlite: SqliteSnapshotDeps = {
    applied,
    run: () => {
      helperCalls++;
      return Effect.die("Offline pruning must not access SQLite or start a helper");
    },
    pullArtifact: () => {
      imageCalls++;
      return Effect.die("Offline pruning must not acquire a helper image");
    },
    paths: { ownerSnapshotsDir: () => join(root, "catalog") },
    stateStore: {
      open: () => Effect.die("Offline pruning must not open a database or helper scratch state bucket"),
      withLock: <A, E>(_key: string, body: Effect.Effect<A, E>) =>
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
    },
    removeSnapshot: (handle) =>
      Effect.sync(() => {
        expect(locked).toBe(true);
        const index = catalog.findIndex(
          (entry) =>
            entry.id === handle.id &&
            entry.owner.ownerKey === handle.ownerKey &&
            entry.store.app === handle.store.app &&
            entry.store.store === handle.store.store,
        );
        if (index < 0) throw new Error("An unconfirmed snapshot handle was selected");
        removed.push(handle);
        catalog.splice(index, 1);
      }),
  };
  const deps: SqlCommandDeps = {
    ...harness.deps,
    sqlite,
    plan: {
      ...harness.deps.plan,
      identity: ownerIdentity,
      services: {
        database: {
          name: "database",
          type: "php:8.3",
          sqlite: { path: target.path },
          environment: {},
          storage: [],
          mounts: [{ type: "bind", source: root, target: "/app", role: "app", readOnly: true }],
        },
      },
    },
    canonicalizeSourcePath: (path) => Effect.succeed(AbsolutePath.make(path)),
    listSnapshots: (filter) =>
      Effect.sync(() => {
        observedFilters.push(filter);
        return catalog.filter(
          (entry) =>
            (filter.app === undefined || entry.store.app === filter.app) &&
            (filter.store === undefined || entry.store.store === filter.store) &&
            (filter.ownerKey === undefined || entry.owner.ownerKey === filter.ownerKey) &&
            (filter.repoGroupKey === undefined || entry.owner.repoGroupKey === filter.repoGroupKey) &&
            (filter.service === undefined || entry.metadata?.service === filter.service),
        );
      }),
    pruneSnapshots: () => Effect.die("Manual pruning must remove only exact confirmed handles"),
  };
  const assertOffline = () => {
    expect(helperCalls).toBe(0);
    expect(imageCalls).toBe(0);
    expect(existsSync(join(root, target.path))).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith(".lando-sqlite-proof."))).toBe(false);
  };
  return {
    deps,
    sqlite,
    target,
    root,
    sourceRoot,
    catalog,
    snapshot,
    removed,
    observedFilters,
    assertOffline,
  };
};

describe("offline SQLite manual snapshot pruning", () => {
  for (const source of ["fromPath", "fromApp"] as const) {
    for (const preview of [true, false]) {
      test(`${source} keep0 ${preview ? "preview" : "apply"} selects the explicit source without opening a missing or read-only database`, async () => {
        const f = setup();
        const expected = [
          "a-old",
          "a-new",
          "b-old",
          "b-new",
          source === "fromPath" ? "renamed-app-same-owner" : "shared-app-other-owner",
        ].sort();
        const selectors = source === "fromPath" ? { fromPath: f.sourceRoot } : { fromApp: "source-app" };
        const result = await Effect.runPromise(
          executeSqliteCommand(
            f.deps,
            { action: "prune", yes: true, keepLatest: 0, preview, ...selectors },
            f.target,
          ),
        );
        expect([...(result.pruneCandidates ?? [])].sort()).toEqual(expected);
        expect(f.removed.map((entry) => entry.id).sort()).toEqual(preview ? [] : expected);
        expect(result.retentionApplied).toBe(!preview);
        expect(f.catalog.some((entry) => entry.id === "automatic")).toBe(true);
        expect(f.catalog.some((entry) => entry.id === "postgres")).toBe(true);
        expect(f.catalog.some((entry) => entry.id === "other-service")).toBe(true);
        if (source === "fromPath")
          expect(f.observedFilters[0]?.ownerKey).toBe(appIdentityKey("owner", f.sourceRoot));
        else
          expect(f.observedFilters[0]).toMatchObject({
            app: "source-app",
            repoGroupKey: "shared-repository",
          });
        f.assertOffline();
      });
    }
  }

  test("retains newer current and foreign-target records inserted during confirmation", async () => {
    const f = setup();
    let confirmations = 0;
    const deps = {
      ...f.deps,
      confirm: () =>
        Effect.sync(() => {
          confirmations++;
          f.catalog.push(
            f.snapshot("new-current", { root: f.root, app: f.deps.plan.id }),
            f.snapshot("new-foreign", {
              root: f.root,
              app: f.deps.plan.id,
              descriptor: "different-physical-target",
            }),
          );
          return true;
        }),
    };
    const result = await Effect.runPromise(
      executeSqliteCommand(deps, { action: "prune", yes: false, keepLatest: 0 }, f.target),
    );
    expect(confirmations).toBe(1);
    expect(result.prunedSnapshotIds).toEqual(["local"]);
    expect(f.catalog.some((entry) => entry.id === "new-current")).toBe(true);
    expect(f.catalog.some((entry) => entry.id === "new-foreign")).toBe(true);
    f.assertOffline();
  });

  test("preview needs no snapshot removal capability", async () => {
    const f = setup();
    const { removeSnapshot: _removeSnapshot, ...sqlite } = f.sqlite;
    const result = await Effect.runPromise(
      executeSqliteCommand(
        { ...f.deps, sqlite },
        { action: "prune", yes: true, preview: true, keepLatest: 0 },
        f.target,
      ),
    );
    expect(result.pruneCandidates).toEqual(["local"]);
    expect(f.removed).toEqual([]);
    f.assertOffline();
  });

  test("keeps the newest snapshot independently for each physical target and catalog scope", () => {
    const f = setup();
    const selected = sqliteManualPruneSelection(f.catalog, 1)
      .candidates.map((entry) => entry.id)
      .sort();
    expect(selected).toEqual(["a-old", "b-old"]);
  });
});
