import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { FileSyncSessionRef } from "@lando/sdk/schema";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";

import { destroyAppForTarget } from "../../src/operations/destroy.ts";
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
  pauseSession: () => Effect.void,
  resumeSession: () => Effect.void,
  terminateSession: () => Effect.void,
  listSessions: () => Effect.succeed([]),
  streamEvents: () => Stream.empty,
});

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
    const harness = makeHarness({ fileSync: availableFileSync() });

    // When
    await runDestroyTarget(harness);

    // Then
    const parentId = destroyTreeId(String(plan.id));
    const fileSyncId = startChildTaskId(parentId, "file-sync");
    expect(byTag(harness.events, "task.tree.start")[0]?.children[0]).toBe(fileSyncId);
    expect(byTag(harness.events, "task.complete").map((event) => event.taskId)).toContain(fileSyncId);
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

  test("declares snapshots only when volumes is true", async () => {
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
    expect(byTag(volumesHarness.events, "task.tree.start")[0]?.children).toContain(snapshotId);
    expect(byTag(volumesHarness.events, "task.complete").map((event) => event.taskId)).toContain(snapshotId);
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
