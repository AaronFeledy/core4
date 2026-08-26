import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";

import { type AppPlan, FileSyncSessionRef, type FileSyncSessionSpec, PortablePath } from "@lando/sdk/schema";
import { startChildTaskId } from "@lando/sdk/task-progress";

import {
  applyTreeId,
  startFileSyncTreeId,
  startHostProxyTreeId,
  startRoutesTreeId,
} from "../../src/operations/start-progress.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  byTag,
  makeHarness,
  plan,
  runStart,
  startOwnedParentIds,
  web,
} from "./start-progress-topology-support.ts";

describe("start progress topology", () => {
  test("skips start-owned trees when global, host-proxy, file-sync, and routes are inapplicable", async () => {
    const harness = makeHarness();
    await runStart(harness);

    expect(startOwnedParentIds(harness.events)).toEqual([]);
    expect(byTag(harness.events, "task.tree.start").map((event) => event.parentId)).toEqual([
      applyTreeId(String(plan.id)),
    ]);
    expect(byTag(harness.events, "task.tree.complete").map((event) => event.parentId)).toEqual([
      applyTreeId(String(plan.id)),
    ]);
  });

  test("emits a routes tree only when routes exist and settles it after apply", async () => {
    const routedPlan: AppPlan = {
      ...plan,
      routes: [
        {
          hostname: "web.test-start.lndo.site",
          scheme: "https",
          service: web.name,
          endpoint: 3000,
          backend: { service: web.name, protocol: "http", port: 3000 },
        },
      ],
    };
    const harness = makeHarness({ plannedApp: routedPlan });
    await runStart(harness, routedPlan);

    const parentId = startRoutesTreeId(String(plan.id));
    const treeStarts = byTag(harness.events, "task.tree.start");
    expect(treeStarts.map((event) => event.parentId)).toEqual([applyTreeId(String(plan.id)), parentId]);
    expect(treeStarts[1]).toMatchObject({
      parentId,
      children: [startChildTaskId(parentId, "apply")],
    });
    const applyCompleteIndex = harness.events.findIndex(
      (event) => event._tag === "task.tree.complete" && event.parentId === applyTreeId(String(plan.id)),
    );
    const routesStartIndex = harness.events.findIndex(
      (event) => event._tag === "task.tree.start" && event.parentId === parentId,
    );
    expect(applyCompleteIndex).toBeGreaterThan(-1);
    expect(routesStartIndex).toBeGreaterThan(applyCompleteIndex);
    expect(byTag(harness.events, "task.tree.complete").map((event) => event.parentId)).toEqual([
      applyTreeId(String(plan.id)),
      parentId,
    ]);
  });

  test("owns file-sync detail with matching tree and task ids", async () => {
    const planWithFileSync: AppPlan = {
      ...plan,
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app: { kind: "user", id: plan.id, root: plan.root },
            service: web.name,
            mountKey: "app-mount",
            source: plan.root,
            target: { _tag: "volume", name: "test-start-web-app-mount", path: PortablePath.make("/app") },
            mode: "two-way-safe",
            excludes: [],
          },
        },
      ],
    };
    let setupComplete = false;
    const harness = makeHarness({
      plannedApp: planWithFileSync,
      fileSync: {
        id: "mutagen",
        displayName: "Mutagen",
        capabilities: {
          modes: ["two-way-safe"],
          remoteAgentDeployment: "auto",
          exclusionPatterns: true,
          conflictReporting: true,
          progressReporting: true,
        },
        isAvailable: Effect.sync(() => setupComplete),
        setup: () =>
          Effect.sync(() => {
            setupComplete = true;
          }),
        createSession: (spec: FileSyncSessionSpec) =>
          Effect.succeed(FileSyncSessionRef.make(`${spec.app.id}-${spec.service}-${spec.mountKey}`)),
        pauseSession: () => Effect.void,
        resumeSession: () => Effect.void,
        terminateSession: () => Effect.void,
        listSessions: () => Effect.succeed([]),
        streamEvents: () => Stream.empty,
      },
    });
    await runStart(harness, planWithFileSync);

    const parentId = startFileSyncTreeId(String(plan.id));
    const setupId = startChildTaskId(parentId, "setup");
    const tags = harness.events.map((event) => event._tag);
    const treeStart = harness.events.findIndex(
      (event) => event._tag === "task.tree.start" && event.parentId === parentId,
    );
    const taskStart = harness.events.findIndex(
      (event) => event._tag === "task.start" && event.taskId === setupId,
    );
    const detail = harness.events.findIndex(
      (event) => event._tag === "task.detail" && event.taskId === setupId,
    );
    const taskComplete = harness.events.findIndex(
      (event) => (event._tag === "task.complete" || event._tag === "task.fail") && event.taskId === setupId,
    );
    const treeComplete = harness.events.findIndex(
      (event) => event._tag === "task.tree.complete" && event.parentId === parentId,
    );
    expect(treeStart).toBeGreaterThan(-1);
    expect(taskStart).toBeGreaterThan(treeStart);
    expect(detail).toBeGreaterThan(taskStart);
    expect(taskComplete).toBeGreaterThan(detail);
    expect(treeComplete).toBeGreaterThan(taskComplete);
    expect(tags.filter((tag) => tag === "task.tree.start").length).toBeGreaterThan(1);
    expect(startOwnedParentIds(harness.events).every((id) => id === parentId)).toBe(true);
  });

  test("does not emit a host-proxy tree when no service is eligible", async () => {
    const harness = makeHarness();
    await runStart(harness);
    expect(
      harness.events.some(
        (event) =>
          event._tag === "task.tree.start" && event.parentId === startHostProxyTreeId(String(plan.id)),
      ),
    ).toBe(false);
  });

  test("settles the apply tree when start is interrupted after the tree opens", async () => {
    const harness = makeHarness({ applyEffect: Effect.never });
    const fiber = Effect.runFork(
      startApp({}, { plan, root: plan.root, app: { kind: "user", id: plan.id, root: plan.root } }).pipe(
        Effect.provide(harness.layer),
      ),
    );
    await harness.applyTreeStarted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const parentId = applyTreeId(String(plan.id));
    expect(byTag(harness.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      children: ["web"],
    });
    expect(byTag(harness.events, "task.start").map((event) => event.taskId)).toContain("web");
    expect(byTag(harness.events, "task.fail").map((event) => event.taskId)).toContain("web");
    expect(byTag(harness.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      failed: 1,
    });
  });
});
