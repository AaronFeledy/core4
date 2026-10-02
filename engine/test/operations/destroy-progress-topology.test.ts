import { describe, expect, test } from "bun:test";
import { FileSyncStopError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type FileSyncSessionInfo, FileSyncSessionRef, PortablePath, ServiceName } from "@lando/sdk/schema";
import { type StateStoreShape, physicalVolumeLockKey } from "@lando/sdk/services";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { DateTime, Effect, Exit, Fiber, Stream } from "effect";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import {
  byTag,
  destroyTreeId,
  makeHarness,
  plan,
  runDestroyTarget,
} from "./destroy-progress-topology-support.ts";

const availableFileSync = (): FileSyncEngineShape => ({
  id: "mutagen",
  displayName: "Mutagen",
  capabilities: {
    modes: ["two-way-safe"],
    remoteAgentDeployment: "none",
    exclusionPatterns: false,
    conflictReporting: false,
    progressReporting: false,
  },
  isAvailable: Effect.succeed(true),
  setup: () => Effect.void,
  createSession: () => Effect.succeed(FileSyncSessionRef.make("session")),
  flushSession: () => Effect.void,
  pauseSession: () => Effect.void,
  resumeSession: () => Effect.void,
  terminateSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  streamEvents: () => Stream.empty,
});

const app = { kind: "user" as const, id: plan.id, root: plan.root };
const syncSession: FileSyncSessionInfo = {
  ref: FileSyncSessionRef.make("destroy-web-app-mount"),
  app,
  service: ServiceName.make("web"),
  mountKey: "app-mount",
  spec: {
    app,
    service: ServiceName.make("web"),
    mountKey: "app-mount",
    source: plan.root,
    target: { _tag: "volume", name: "destroy-web-app-mount", path: PortablePath.make("/app") },
    mode: "two-way-safe",
    excludes: [],
  },
  status: "running",
  lastUpdatedAt: DateTime.unsafeMake("2026-09-23T00:00:00Z"),
};
describe("destroy progress topology", () => {
  test("publishes one destroy tree between pre-destroy and post-destroy", async () => {
    // Given: a resolved destroy target with proxy cleanup and no file-sync.
    const harness = makeHarness();

    // When: the real destroy operation runs.
    const result = await runDestroyTarget(harness);

    // Then: a destroy tree opens after pre-destroy and closes before post-destroy.
    const parentId = destroyTreeId(String(plan.id));
    const tags = harness.events.map((event) => event._tag);
    const pre = tags.indexOf("pre-destroy");
    const post = tags.indexOf("post-destroy");
    const treeStart = harness.events.findIndex(
      (event) => event._tag === "task.tree.start" && event.parentId === parentId,
    );
    const treeComplete = harness.events.findIndex(
      (event) => event._tag === "task.tree.complete" && event.parentId === parentId,
    );
    expect(pre).toBeGreaterThan(-1);
    expect(treeStart).toBeGreaterThan(pre);
    expect(treeComplete).toBeGreaterThan(treeStart);
    expect(post).toBeGreaterThan(treeComplete);
    expect(byTag(harness.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      label: "Destroy test-destroy",
      children: [
        startChildTaskId(parentId, "provider"),
        startChildTaskId(parentId, "host-proxy"),
        startChildTaskId(parentId, "routes"),
      ],
    });
    expect(result.app).toBe("test-destroy");
  });

  test("omits file-sync and snapshots children on the default path", async () => {
    // Given: no FileSyncEngine and volumes left false.
    const harness = makeHarness();

    // When
    await runDestroyTarget(harness);

    // Then
    const parentId = destroyTreeId(String(plan.id));
    const treeStart = byTag(harness.events, "task.tree.start");
    expect(treeStart).toHaveLength(1);
    const children = treeStart[0]?.children ?? [];
    expect(children).not.toContain(startChildTaskId(parentId, "file-sync"));
    expect(children).not.toContain(startChildTaskId(parentId, "snapshots"));
  });

  test("includes a completed file-sync child when the engine is available", async () => {
    // Given
    const harness = makeHarness({
      fileSync: { ...availableFileSync(), listSessions: () => Effect.succeed([syncSession]) },
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      quiesceEffect: Effect.void,
    });

    // When
    await runDestroyTarget(harness);

    // Then
    const parentId = destroyTreeId(String(plan.id));
    const fileSyncId = startChildTaskId(parentId, "file-sync");
    expect(byTag(harness.events, "task.tree.start")[0]?.children[0]).toBe(fileSyncId);
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(fileSyncId);
  });

  test("rejects unknown applied state before init hooks run", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "unknown",
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({}, { plan, root: plan.root, app }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
    expect(byTag(harness.events, "pre-init")).toEqual([]);
    expect(byTag(harness.events, "post-init")).toEqual([]);
  });

  test.each([false, true])(
    "preserves durable sync ownership until provider cleanup is verified (volumes=%s)",
    async (volumes) => {
      const calls: string[] = [];
      const engine: FileSyncEngineShape = {
        ...availableFileSync(),
        sessionsPersistAcrossProcesses: true,
        appLifecycle: {
          invalidateDrain: () => Effect.void,
          drain: () =>
            Effect.sync(() => {
              calls.push("drain");
            }),
          dispose: () =>
            Effect.sync(() => {
              calls.push("dispose");
            }),
          completeDisposal: () =>
            Effect.sync(() => {
              calls.push("complete");
            }),
        },
      };
      const harness = makeHarness({
        fileSync: engine,
        appliedFileSyncState: "accelerated",
        appliedFileSyncSessions: [syncSession.spec],
        quiesceEffect: Effect.sync(() => {
          calls.push("quiesce");
        }),
        destroyEffect: Effect.sync(() => {
          calls.push("destroy");
        }),
      });
      const exit = await Effect.runPromiseExit(
        destroyAppForTarget({ volumes }, { plan, root: plan.root, app }).pipe(Effect.provide(harness.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual([]);
      expect(byTag(harness.events, "pre-init")).toEqual([]);
      expect(byTag(harness.events, "post-init")).toEqual([]);
      expect(byTag(harness.events, "pre-destroy")).toEqual([]);
    },
  );

  test("quiesces writers before flushing and destroying accelerated volumes", async () => {
    const calls: string[] = [];
    const engine = {
      ...availableFileSync(),
      listSessions: () => Effect.succeed([syncSession]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
        }),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }),
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      fileSync: engine,
      quiesceEffect: Effect.sync(() => {
        calls.push("quiesce");
      }),
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    await runDestroyTarget(harness, { volumes: true });
    expect(calls).toEqual(["quiesce", "flush", "terminate", "destroy"]);
  });

  test("a failed final flush preserves accelerated volumes", async () => {
    const calls: string[] = [];
    const failure = new FileSyncStopError({
      engineId: "mutagen",
      sessionRef: String(syncSession.ref),
      message: "flush failed",
    });
    const engine = {
      ...availableFileSync(),
      listSessions: () => Effect.succeed([syncSession]),
      flushSession: () => Effect.fail(failure),
      terminateSession: () =>
        Effect.sync(() => {
          calls.push("terminate");
        }),
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      fileSync: engine,
      quiesceEffect: Effect.sync(() => {
        calls.push("quiesce");
      }),
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["quiesce"]);
  });

  test("a file sync engine lost after quiescence preserves volumes", async () => {
    const calls: string[] = [];
    let readinessChecks = 0;
    const engine = {
      ...availableFileSync(),
      isAvailable: Effect.sync(() => ++readinessChecks === 1),
      listSessions: () => Effect.succeed([syncSession]),
      flushSession: () =>
        Effect.sync(() => {
          calls.push("flush");
        }),
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      fileSync: engine,
      quiesceEffect: Effect.sync(() => {
        calls.push("quiesce");
      }),
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(readinessChecks).toBe(2);
    expect(calls).toEqual(["quiesce"]);
  });
  test("destroys a previously ordinary app when the current plan proposes acceleration", async () => {
    const calls: string[] = [];
    const planned = { ...plan, fileSync: [{ engineId: "mutagen", session: syncSession.spec }] };
    const harness = makeHarness({
      appliedFileSyncState: "ordinary",
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan: planned, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(calls).toEqual(["destroy"]);
  });

  test("a planned accelerated mount without its session preserves volumes", async () => {
    const calls: string[] = [];
    const acceleratedPlan = { ...plan, fileSync: [{ engineId: "mutagen", session: syncSession.spec }] };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      fileSync: availableFileSync(),
      quiesceEffect: Effect.sync(() => {
        calls.push("quiesce");
      }),
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan: acceleratedPlan, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("a prior accelerated mount omitted from the current plan preserves volumes", async () => {
    const calls: string[] = [];
    const previousSecondMount = {
      ...syncSession.spec,
      mountKey: "mount-1",
      target: { ...syncSession.spec.target, name: "destroy-web-mount-1" },
    };
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec, previousSecondMount],
      fileSync: { ...availableFileSync(), listSessions: () => Effect.succeed([syncSession]) },
      quiesceEffect: Effect.sync(() => {
        calls.push("quiesce");
      }),
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("active sync fails closed when provider cannot quiesce writers", async () => {
    const calls: string[] = [];
    const harness = makeHarness({
      appliedFileSyncState: "accelerated",
      appliedFileSyncSessions: [syncSession.spec],
      fileSync: { ...availableFileSync(), listSessions: () => Effect.succeed([syncSession]) },
      destroyEffect: Effect.sync(() => {
        calls.push("destroy");
      }),
    });
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget({ volumes: true }, { plan, root: plan.root, app }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual([]);
  });
  test("omits routes when proxy is missing and still warns", async () => {
    // Given
    const harness = makeHarness({ proxyAvailable: false });

    // When
    await runDestroyTarget(harness);

    // Then
    const parentId = destroyTreeId(String(plan.id));
    expect(byTag(harness.events, "task.tree.start")[0]?.children).toEqual([
      startChildTaskId(parentId, "provider"),
      startChildTaskId(parentId, "host-proxy"),
    ]);
    expect(byTag(harness.events, "message.warn")[0]?.body).toContain("without route cleanup");
  });

  test("preserves snapshots when destroying volumes", async () => {
    // Given
    const defaultHarness = makeHarness();
    const purgeHarness = makeHarness();
    const volumesHarness = makeHarness();

    // When
    await runDestroyTarget(defaultHarness);
    await runDestroyTarget(purgeHarness, { purgeCaches: true });
    await runDestroyTarget(volumesHarness, { volumes: true });

    // Then
    const parentId = destroyTreeId(String(plan.id));
    const snapshotId = startChildTaskId(parentId, "snapshots");
    expect(byTag(defaultHarness.events, "task.tree.start")[0]?.children).not.toContain(snapshotId);
    expect(byTag(purgeHarness.events, "task.tree.start")[0]?.children).not.toContain(snapshotId);
    expect(byTag(volumesHarness.events, "task.tree.start")[0]?.children).not.toContain(snapshotId);
    expect(byTag(volumesHarness.events, "task.complete").map((event) => event.taskId)).not.toContain(
      snapshotId,
    );
  });

  test("holds the physical-volume lock while destroying volumes", async () => {
    // Given: a provider volume with durable physical identity.
    const baseStateStore = makeTestStateStore().service;
    const lockKeys: string[] = [];
    let lockHeld = false;
    const stateStore: StateStoreShape = {
      ...baseStateStore,
      withLock: (key, body) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            lockKeys.push(key);
            lockHeld = true;
          }),
          () => body,
          () =>
            Effect.sync(() => {
              lockHeld = false;
            }),
        ),
    };
    let destroyObservedLock = false;
    const harness = makeHarness({
      stateStore,
      volumes: [
        {
          ref: { app: plan.id, store: "database", scope: "service" },
          instanceId: "volume-instance-1",
          provenance: "known",
        },
      ],
      destroyEffect: Effect.sync(() => {
        destroyObservedLock = lockHeld;
      }),
    });

    // When: destroy removes persistent volumes.
    await runDestroyTarget(harness, { volumes: true });

    // Then: provider mutation occurs while holding the shared physical-volume lock.
    expect(destroyObservedLock).toBe(true);
    expect(lockKeys).toEqual([physicalVolumeLockKey(JSON.stringify(["endpoint:test", "database"]))]);
    expect(lockHeld).toBe(false);
  });

  test("fails the provider task and still runs routes", async () => {
    // Given
    const providerFailure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "destroy",
      message: "provider destroy failed",
    });
    const harness = makeHarness({ destroyEffect: Effect.fail(providerFailure) });

    // When
    const exit = await Effect.runPromiseExit(
      destroyAppForTarget(
        {},
        { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
      ).pipe(Effect.provide(harness.layer)),
    );

    // Then
    const parentId = destroyTreeId(String(plan.id));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(byTag(harness.events, "task.fail").map((event) => event.taskId)).toContain(
      startChildTaskId(parentId, "provider"),
    );
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(
      startChildTaskId(parentId, "routes"),
    );
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(
      startChildTaskId(parentId, "host-proxy"),
    );
  });

  test("completes host-proxy via ensuring when provider destroy is interrupted", async () => {
    // Given: provider destroy starts, then hangs.
    let signalStarted = (): void => undefined;
    const destroyStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const harness = makeHarness({
      destroyEffect: Effect.sync(() => {
        signalStarted();
      }).pipe(Effect.zipRight(Effect.never)),
    });

    // When
    const fiber = Effect.runFork(
      destroyAppForTarget(
        {},
        { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } },
      ).pipe(Effect.provide(harness.layer)),
    );
    await destroyStarted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Then
    const parentId = destroyTreeId(String(plan.id));
    expect(byTag(harness.events, "task.tree.start")[0]?.parentId).toBe(parentId);
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(
      startChildTaskId(parentId, "host-proxy"),
    );
    expect(byTag(harness.events, "task.fail").map((event) => event.taskId)).toContain(
      startChildTaskId(parentId, "provider"),
    );
    expect(byTag(harness.events, "task.tree.complete")[0]).toMatchObject({ parentId });
    expect(byTag(harness.events, "task.tree.complete")[0]?.failed).toBeGreaterThan(0);
  });
});
