import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, test } from "bun:test";
import { Effect, Either } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import { AbsolutePath, AppId, PortablePath } from "@lando/sdk/schema";

import {
  beginAcceleratedStart,
  requireNoPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startAppForTarget } from "../../src/operations/start.ts";
import { stopAppForTarget } from "../../src/operations/stop.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const otherTestRoot = mkdtempSync(join(tmpdir(), "lando-journal-other-"));
const foreignTestRoot = mkdtempSync(join(tmpdir(), "lando-journal-foreign-"));
afterAll(() => {
  rmSync(otherTestRoot, { recursive: true, force: true });
  rmSync(foreignTestRoot, { recursive: true, force: true });
});

const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };
const acceleratedPlan: AppPlan = {
  ...plan,
  fileSync: [
    {
      engineId: "mutagen",
      session: {
        app: target.app,
        service: web.name,
        mountKey: "app-mount",
        source: plan.root,
        target: { _tag: "volume", name: "test-start-sync", path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
};

test("pending accelerated start blocks changed ordinary plan before every lifecycle hook or provider action", async () => {
  const stateStore = makeTestStateStore();
  const pending = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, target.app).pipe(Effect.provide(stateStore.layer)),
  );
  await Effect.runPromise(pending.phase("sessions-ready").pipe(Effect.provide(stateStore.layer)));
  await Effect.runPromise(pending.phase("apply-intent").pipe(Effect.provide(stateStore.layer)));

  for (const [name, operation] of [
    [
      "start",
      (harness: ReturnType<typeof makeHarness>) =>
        Effect.runPromise(
          startAppForTarget(undefined, target).pipe(Effect.provide(harness.layer), Effect.either),
        ).then(Either.isLeft),
    ],
    [
      "restart",
      (harness: ReturnType<typeof makeHarness>) =>
        Effect.runPromise(restartApp({}, target).pipe(Effect.provide(harness.layer), Effect.either)).then(
          Either.isLeft,
        ),
    ],
    [
      "rebuild",
      (harness: ReturnType<typeof makeHarness>) =>
        Effect.runPromise(rebuildApp({}, target).pipe(Effect.provide(harness.layer), Effect.either)).then(
          Either.isLeft,
        ),
    ],
    [
      "stop",
      (harness: ReturnType<typeof makeHarness>) =>
        Effect.runPromise(
          stopAppForTarget({}, target).pipe(Effect.provide(harness.layer), Effect.either),
        ).then(Either.isLeft),
    ],
    [
      "destroy",
      (harness: ReturnType<typeof makeHarness>) =>
        Effect.runPromise(
          destroyAppForTarget({}, target).pipe(Effect.provide(harness.layer), Effect.either),
        ).then(Either.isLeft),
    ],
  ] as const) {
    const actions: string[] = [];
    const harness = makeHarness({
      stateStore,
      onApply: () => actions.push("apply"),
      onDestroy: () => actions.push("destroy"),
      onPublish: () =>
        Effect.sync(() => {
          actions.push("hook");
        }),
    });
    expect(await operation(harness), name).toBe(true);
    expect(actions, name).toEqual([]);
    expect(harness.events, name).toEqual([]);
  }
});

test("atomic completed tombstone permits a fresh attempt while stale owners cannot overwrite it", async () => {
  const stateStore = makeTestStateStore();
  const first = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, target.app).pipe(Effect.provide(stateStore.layer)),
  );
  await Effect.runPromise(first.phase("sessions-ready").pipe(Effect.provide(stateStore.layer)));
  await Effect.runPromise(first.clear.pipe(Effect.provide(stateStore.layer)));
  await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app).pipe(Effect.provide(stateStore.layer)),
  );
  const second = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, target.app).pipe(Effect.provide(stateStore.layer)),
  );
  expect(second.attemptId).not.toBe(first.attemptId);
  const stale = await Effect.runPromise(
    first.phase("apply-intent").pipe(Effect.provide(stateStore.layer), Effect.either),
  );
  expect(Either.isLeft(stale)).toBe(true);
  const stillPending = await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app).pipe(Effect.provide(stateStore.layer), Effect.either),
  );
  expect(Either.isLeft(stillPending)).toBe(true);
});

test("a pending attempt for one root does not block another app with the same ID", async () => {
  const stateStore = makeTestStateStore();
  const pending = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, target.app).pipe(Effect.provide(stateStore.layer)),
  );
  await Effect.runPromise(pending.phase("sessions-ready").pipe(Effect.provide(stateStore.layer)));
  await Effect.runPromise(pending.phase("apply-intent").pipe(Effect.provide(stateStore.layer)));

  const otherRoot = AbsolutePath.make(otherTestRoot);
  const otherApp = { ...target.app, root: otherRoot };
  const otherPlan: AppPlan = {
    ...acceleratedPlan,
    root: otherRoot,
    fileSync: acceleratedPlan.fileSync.map((entry) => ({
      ...entry,
      session: { ...entry.session, app: otherApp, source: otherRoot },
    })),
  };
  await Effect.runPromise(requireNoPendingAcceleratedStart(otherApp).pipe(Effect.provide(stateStore.layer)));
  const otherAttempt = await Effect.runPromise(
    beginAcceleratedStart(otherPlan, otherApp).pipe(Effect.provide(stateStore.layer)),
  );
  expect(otherAttempt.attemptId).not.toBe(pending.attemptId);
  const originalPending = await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app).pipe(Effect.provide(stateStore.layer), Effect.either),
  );
  expect(Either.isLeft(originalPending)).toBe(true);
});

test("rejects a mismatched session app before creating a journal under either identity", async () => {
  const stateStore = makeTestStateStore();
  const entry = acceleratedPlan.fileSync[0];
  if (entry === undefined) throw new Error("Missing accelerated test session");
  const otherApp = { ...target.app, root: AbsolutePath.make(foreignTestRoot) };
  const mismatchedPlan: AppPlan = {
    ...acceleratedPlan,
    fileSync: [{ ...entry, session: { ...entry.session, app: otherApp } }],
  };
  const rejected = await Effect.runPromise(
    beginAcceleratedStart(mismatchedPlan, target.app).pipe(Effect.provide(stateStore.layer), Effect.either),
  );
  expect(Either.isLeft(rejected)).toBe(true);
  await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app).pipe(Effect.provide(stateStore.layer)),
  );
  await Effect.runPromise(requireNoPendingAcceleratedStart(otherApp).pipe(Effect.provide(stateStore.layer)));
});

test("a mismatched resolved target cannot bypass a pending plan journal", async () => {
  const stateStore = makeTestStateStore();
  const pending = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, target.app).pipe(Effect.provide(stateStore.layer)),
  );
  const wrongRef = { ...target.app, root: AbsolutePath.make("/tmp/other-target") };
  const result = await Effect.runPromise(
    requireNoPendingAcceleratedStart(wrongRef, acceleratedPlan).pipe(
      Effect.provide(stateStore.layer),
      Effect.either,
    ),
  );
  expect(Either.isLeft(result)).toBe(true);
  const harness = makeHarness({ stateStore });
  const operation = await Effect.runPromise(
    startAppForTarget(undefined, { ...target, app: wrongRef }).pipe(
      Effect.provide(harness.layer),
      Effect.either,
    ),
  );
  expect(Either.isLeft(operation)).toBe(true);
  expect(harness.events).toEqual([]);
  const original = await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app, acceleratedPlan).pipe(
      Effect.provide(stateStore.layer),
      Effect.either,
    ),
  );
  expect(Either.isLeft(original)).toBe(true);
  expect(pending.attemptId).toBeTruthy();
});

test("accelerated scratch journal belongs to the captured scratch ref", async () => {
  const stateStore = makeTestStateStore();
  const scratchRef = { ...target.app, kind: "scratch" as const };
  const scratchPlan: AppPlan = {
    ...acceleratedPlan,
    fileSync: acceleratedPlan.fileSync.map((entry) => ({
      ...entry,
      session: { ...entry.session, app: scratchRef },
    })),
  };
  const pending = await Effect.runPromise(
    beginAcceleratedStart(scratchPlan, scratchRef).pipe(Effect.provide(stateStore.layer)),
  );
  const scratchPending = await Effect.runPromise(
    requireNoPendingAcceleratedStart(scratchRef, scratchPlan).pipe(
      Effect.provide(stateStore.layer),
      Effect.either,
    ),
  );
  expect(Either.isLeft(scratchPending)).toBe(true);
  await Effect.runPromise(
    requireNoPendingAcceleratedStart(target.app, acceleratedPlan).pipe(Effect.provide(stateStore.layer)),
  );
  const wrongKind = await Effect.runPromise(
    beginAcceleratedStart(scratchPlan, target.app).pipe(Effect.provide(stateStore.layer), Effect.either),
  );
  expect(Either.isLeft(wrongKind)).toBe(true);
  expect(pending.attemptId).toBeTruthy();
});

test("pending journal follows a physical root through alias and changed app ID", async () => {
  const base = await mkdtemp(join(tmpdir(), "lando-journal-alias-"));
  try {
    const alias = join(base, "alias");
    await symlink(base, alias, "dir");
    const physicalRoot = AbsolutePath.make(base);
    const aliasRoot = AbsolutePath.make(alias);
    const original = { ...target.app, root: physicalRoot };
    const originalPlan: AppPlan = {
      ...acceleratedPlan,
      root: physicalRoot,
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        session: { ...entry.session, app: original, source: physicalRoot },
      })),
    };
    const stateStore = makeTestStateStore();
    const pending = await Effect.runPromise(
      beginAcceleratedStart(originalPlan, original).pipe(Effect.provide(stateStore.layer)),
    );
    const changed = { ...original, id: AppId.make("renamed"), root: aliasRoot };
    const blocked = await Effect.runPromise(
      requireNoPendingAcceleratedStart(changed).pipe(Effect.provide(stateStore.layer), Effect.either),
    );
    expect(Either.isLeft(blocked)).toBe(true);
    expect(pending.attemptId).toBeTruthy();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
