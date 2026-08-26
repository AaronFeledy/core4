import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Schema } from "effect";

import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent as PublishedEvent } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree, startChildTaskId } from "@lando/sdk/task-progress";

const collectPublisher = () => {
  const events: LandoEvent[] = [];
  return {
    events,
    publish: (event: PublishedEvent) =>
      Schema.is(LandoEventSchema)(event)
        ? Effect.sync(() => {
            events.push(event);
          })
        : Effect.die(new TypeError(`Unexpected event in task-progress test: ${event._tag}`)),
  };
};

const tags = (events: ReadonlyArray<LandoEvent>): ReadonlyArray<string> => events.map((event) => event._tag);

const byTag = <T extends LandoEvent["_tag"]>(events: ReadonlyArray<LandoEvent>, tag: T) =>
  events.filter((event): event is Extract<LandoEvent, { readonly _tag: T }> => event._tag === tag);

describe("@lando/sdk/task-progress controller", () => {
  test("prefixes child ids with the parent id when prefixChildIds is set", () => {
    expect(startChildTaskId("tree-a", "setup")).toBe("tree-a:setup");
  });

  test("settles declared but unstarted children and completes the tree on interrupt", async () => {
    const publisher = collectPublisher();
    const parentId = "routes-app-1";
    const tree = makeTaskTree(publisher, {
      parentId,
      label: "Routes",
      children: [{ id: "apply", label: "Apply routes" }],
      prefixChildIds: true,
    });

    const fiber = Effect.runFork(
      runWithTaskTree(tree, () => Effect.never, {
        success: "routes applied",
        failure: "routes failed",
        interrupt: "routes interrupted",
      }),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(tags(publisher.events)).toEqual([
      "task.tree.start",
      "task.start",
      "task.fail",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      children: [startChildTaskId(parentId, "apply")],
    });
    expect(byTag(publisher.events, "task.start")[0]).toMatchObject({
      taskId: startChildTaskId(parentId, "apply"),
      parentId,
    });
    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId: startChildTaskId(parentId, "apply"),
    });
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      succeeded: 0,
      failed: 1,
    });
  });

  test("fails started children without restarting them on failure", async () => {
    const publisher = collectPublisher();
    const parentId = "apply-app-1";
    const tree = makeTaskTree(publisher, {
      parentId,
      label: "Apply",
      children: [
        { id: "web", label: "Apply service web" },
        { id: "database", label: "Apply service database" },
      ],
    });

    const exit = await Effect.runPromiseExit(
      runWithTaskTree(
        tree,
        (active) =>
          Effect.gen(function* () {
            yield* active.startTask("web");
            yield* active.startTask("database");
            return yield* Effect.fail(new Error("apply rejected"));
          }),
        { success: "applied", failure: "apply failed", interrupt: "apply interrupted" },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(byTag(publisher.events, "task.start").map((event) => event.taskId)).toEqual(["web", "database"]);
    expect(byTag(publisher.events, "task.fail").map((event) => event.taskId)).toEqual(["web", "database"]);
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      succeeded: 0,
      failed: 2,
    });
    expect(byTag(publisher.events, "task.start")).toHaveLength(2);
  });

  test("completes the tree once on success after children settle", async () => {
    const publisher = collectPublisher();
    const parentId = "file-sync-app-1";
    const setupId = startChildTaskId(parentId, "setup");
    const tree = makeTaskTree(publisher, {
      parentId,
      label: "File sync",
      children: [{ id: "setup", label: "Setup file-sync" }],
      prefixChildIds: true,
    });

    await Effect.runPromise(
      runWithTaskTree(
        tree,
        (active) =>
          Effect.gen(function* () {
            yield* active.startTask("setup");
            yield* active.detail(
              "setup",
              "stdout",
              "Completing deferred file-sync setup for accelerated mounts.",
            );
            yield* active.completeTask("setup", "setup complete");
          }),
        { success: "file-sync ready", failure: "file-sync failed", interrupt: "file-sync interrupted" },
      ),
    );

    expect(tags(publisher.events)).toEqual([
      "task.tree.start",
      "task.start",
      "task.detail",
      "task.complete",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.detail")[0]).toMatchObject({
      taskId: setupId,
      stream: "stdout",
    });
    expect(byTag(publisher.events, "task.tree.complete")).toHaveLength(1);
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      succeeded: 1,
      failed: 0,
    });
  });

  test("does not emit a second tree.complete when settle is repeated", async () => {
    const publisher = collectPublisher();
    const tree = makeTaskTree(publisher, {
      parentId: "apply-app-1",
      label: "Apply",
      children: [{ id: "web", label: "web" }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("web");
        yield* tree.completeTask("web");
        yield* tree.settleSuccess("applied");
        yield* tree.settleSuccess("applied");
        yield* tree.settleFailure("failed");
      }),
    );

    expect(byTag(publisher.events, "task.tree.complete")).toHaveLength(1);
  });

  test("measures durationMs from each child start, not shared tree elapsed", async () => {
    const publisher = collectPublisher();
    let now = 1_000;
    const tree = makeTaskTree(publisher, {
      parentId: "apply-app-1",
      label: "Apply",
      children: [
        { id: "web", label: "Apply service web" },
        { id: "database", label: "Apply service database" },
      ],
      now: () => now,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("web");
        now = 1_400;
        yield* tree.startTask("database");
        now = 1_450;
        yield* tree.completeTask("web");
        yield* tree.completeTask("database");
        yield* tree.settleSuccess("applied");
      }),
    );

    const completed = byTag(publisher.events, "task.complete");
    const web = completed.find((event) => event.taskId === "web");
    const database = completed.find((event) => event.taskId === "database");
    expect(web?.durationMs).toBe(450);
    expect(database?.durationMs).toBe(50);
    expect(web?.durationMs).not.toBe(database?.durationMs);
    expect(byTag(publisher.events, "task.tree.complete")[0]?.durationMs).toBe(450);
  });

  test("emits transcriptPath on startTask when provided", async () => {
    const publisher = collectPublisher();
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    const tree = makeTaskTree(publisher, {
      parentId: "build-app-1",
      label: "Build",
      children: [{ id: "web", label: "Build web" }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("web", { transcriptPath });
        yield* tree.completeTask("web");
        yield* tree.close("built");
      }),
    );

    expect(byTag(publisher.events, "task.start")[0]).toMatchObject({
      taskId: "web",
      transcriptPath,
    });
  });

  test("omits transcriptPath on startTask when not provided", async () => {
    const publisher = collectPublisher();
    const tree = makeTaskTree(publisher, {
      parentId: "build-app-1",
      label: "Build",
      children: [{ id: "web", label: "Build web" }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("web");
        yield* tree.completeTask("web");
        yield* tree.close("built");
      }),
    );

    expect(byTag(publisher.events, "task.start")[0]).toMatchObject({ taskId: "web" });
    expect("transcriptPath" in (byTag(publisher.events, "task.start")[0] ?? {})).toBe(false);
  });

  test("emits remediation on failTask when provided", async () => {
    const publisher = collectPublisher();
    const tree = makeTaskTree(publisher, {
      parentId: "tooling:php",
      label: "Tooling: php",
      children: [{ id: "appserver", label: "appserver" }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("appserver");
        yield* tree.failTask("appserver", "failed with exit code 1", {
          exitCode: 1,
          remediation: "rerun with --verbose",
        });
        yield* tree.close("failed");
      }),
    );

    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId: "appserver",
      exitCode: 1,
      remediation: "rerun with --verbose",
    });
  });

  test("does not restart or re-complete an already settled child", async () => {
    const publisher = collectPublisher();
    const tree = makeTaskTree(publisher, {
      parentId: "apply-app-1",
      label: "Apply",
      children: [{ id: "web", label: "web" }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.startTask("web");
        yield* tree.startTask("web");
        yield* tree.completeTask("web", "done");
        yield* tree.completeTask("web", "again");
        yield* tree.failTask("web", "late fail");
        yield* tree.close("applied");
      }),
    );

    expect(byTag(publisher.events, "task.start")).toHaveLength(1);
    expect(byTag(publisher.events, "task.complete")).toHaveLength(1);
    expect(byTag(publisher.events, "task.fail")).toHaveLength(0);
  });
});
