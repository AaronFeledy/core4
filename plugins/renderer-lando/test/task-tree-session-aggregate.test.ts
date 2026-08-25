import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";

import { TaskTreeInputController } from "../src/keybindings.ts";
import { TaskDetailRing } from "../src/task-detail-ring.ts";
import { aggregateRenderState } from "../src/task-tree-aggregate.ts";
import { TaskTreeCollection } from "../src/task-tree-collection.ts";
import { SPINNER_FRAMES, type TaskState, renderLogicalFrame } from "../src/task-tree-render.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");

const treeStart = (parentId: string, label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });
const taskStart = (taskId: string, label: string, parentId: string, transcriptPath?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    label,
    parentId,
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    timestamp: ts,
  });
const taskComplete = (taskId: string, summary: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary,
    durationMs: 10,
    timestamp: ts,
  });
const treeComplete = (parentId: string, summary: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId,
    summary,
    succeeded: 1,
    failed: 0,
    durationMs: 10,
    timestamp: ts,
  });

const makeCollection = (): TaskTreeCollection =>
  new TaskTreeCollection(
    { terminalColumns: 80 },
    { render: () => {}, requestLive: () => {}, dropLive: () => {} },
  );

const plainFrame = (collection: TaskTreeCollection): string =>
  collection.frameLines().map(stripAnsi).join("\n");

describe("TaskTreeCollection session aggregate", () => {
  test("renders sequential one-child trees as sibling rows under one commandId header", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("proxy", "Starting proxy", ["traefik"]));
    collection.consume(taskStart("traefik", "traefik", "proxy"));
    collection.consume(taskComplete("traefik", "traefik ready"));
    expect(collection.consume(treeComplete("proxy", "Proxy ready")).completedLines).toEqual([]);
    collection.consume(treeStart("routes", "Starting routes", ["appserver"]));
    collection.consume(taskStart("appserver", "appserver", "routes"));

    const frame = plainFrame(collection);
    expect(frame.match(/╭─/g)).toHaveLength(1);
    expect(frame).toContain("╭─ app:start");
    expect(frame).toContain("✓ traefik ready");
    expect(frame).toContain("· appserver");
    expect(frame.match(/╰─/g)).toHaveLength(1);
    expect(frame).not.toContain("Starting proxy");
    expect(frame).not.toContain("Starting routes");
  });

  test("same parentId restart replaces that tree's rows and owners", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["old"]));
    collection.consume(taskStart("old", "old", "build"));
    collection.consume(treeStart("build", "Building again", ["fresh"]));
    collection.consume(taskStart("fresh", "fresh", "build"));
    const frame = plainFrame(collection);
    expect(frame).toContain("fresh");
    expect(frame).not.toContain("old");
  });

  test("overlapping trees stay visible together", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("a", "A", ["one"]));
    collection.consume(taskStart("one", "one", "a"));
    collection.consume(treeStart("b", "B", ["two"]));
    collection.consume(taskStart("two", "two", "b"));
    const frame = plainFrame(collection);
    expect(frame).toContain("· one");
    expect(frame).toContain("· two");
  });

  test("closeSession returns one collapsed aggregate titled by commandId", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("proxy", "Starting proxy", ["traefik"]));
    collection.consume(taskStart("traefik", "traefik", "proxy"));
    collection.consume(taskComplete("traefik", "traefik ready"));
    collection.consume(treeComplete("proxy", "Proxy ready"));
    collection.consume(treeStart("routes", "Starting routes", ["appserver"]));
    collection.consume(taskStart("appserver", "appserver", "routes"));
    collection.consume(taskComplete("appserver", "appserver ready"));
    collection.consume(treeComplete("routes", "Routes ready"));
    const closed = collection.closeSession().map(stripAnsi).join("\n");
    expect(closed.match(/╭─/g)).toHaveLength(1);
    expect(closed).toContain("╭─ app:start");
    expect(closed).toContain("✓ traefik ready");
    expect(closed).toContain("✓ appserver ready");
    expect(closed.match(/╰─/g)).toHaveLength(1);
    expect(closed).toContain("╰─ done");
  });

  test("without a session, tree.complete still returns per-tree lines", () => {
    const collection = makeCollection();
    collection.consume(treeStart("build", "Building", ["web"]));
    collection.consume(taskStart("web", "web", "build"));
    collection.consume(taskComplete("web", "web ready"));
    const result = collection.consume(treeComplete("build", "done"));
    expect(result.completedLines.map(stripAnsi).join("\n")).toContain("╭─ done");
  });

  test("cycleTree in session mode keeps the aggregate frame visible", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("a", "A", ["one"]));
    collection.consume(taskStart("one", "one", "a"));
    collection.consume(treeStart("b", "B", ["two"]));
    collection.consume(taskStart("two", "two", "b"));
    expect(collection.cycleTree()).toBe(true);
    const frame = plainFrame(collection);
    expect(frame).toContain("· one");
    expect(frame).toContain("· two");
    expect(frame.match(/╭─/g)).toHaveLength(1);
  });

  test("keeps both phase rows when two parent trees reuse the same taskId", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build"));
    collection.consume(taskComplete("appserver", "image built"));
    expect(collection.consume(treeComplete("build", "Built")).completedLines).toEqual([]);
    collection.consume(treeStart("apply", "Applying", ["appserver"]));
    collection.consume(taskStart("appserver", "apply appserver", "apply"));

    const frame = plainFrame(collection);
    expect(frame).toContain("✓ image built");
    expect(frame).toContain("· apply appserver");
    expect(frame).toContain("╭─ app:start");
    expect(frame.match(/╭─/g)).toHaveLength(1);

    collection.consume(taskComplete("appserver", "service applied"));
    collection.consume(treeComplete("apply", "Applied"));
    const closed = collection.closeSession().map(stripAnsi).join("\n");
    expect(closed).toContain("✓ image built");
    expect(closed).toContain("✓ service applied");
    expect(closed.match(/╭─/g)).toHaveLength(1);
  });

  test("remaps spinning and expanded ids so reused taskIds keep their own row state", () => {
    const done: TaskState = {
      id: "appserver",
      transcriptPath: undefined,
      label: "build appserver",
      status: "done",
      summary: "image built",
      durationMs: 10,
      exitCode: undefined,
      remediation: undefined,
      ring: new TaskDetailRing(),
    };
    const running: TaskState = {
      id: "appserver",
      transcriptPath: undefined,
      label: "apply appserver",
      status: "running",
      summary: undefined,
      durationMs: undefined,
      exitCode: undefined,
      remediation: undefined,
      ring: new TaskDetailRing(),
    };
    const base = {
      spinningTaskIds: new Set<string>(),
      spinnerFrame: 0,
      expandedTaskId: undefined,
      expandedLines: [] as const,
      terminalColumns: 80,
    };
    const aggregated = aggregateRenderState("app:start", [
      {
        parentId: "build",
        state: {
          tree: {
            parentId: "build",
            childCount: 1,
            label: "Building",
            done: true,
            summary: "Built",
            succeeded: 1,
            failed: 0,
            durationMs: 10,
          },
          tasks: new Map([["appserver", done]]),
          order: ["appserver"],
          ...base,
        },
      },
      {
        parentId: "apply",
        state: {
          tree: {
            parentId: "apply",
            childCount: 1,
            label: "Applying",
            done: false,
            summary: undefined,
            succeeded: 0,
            failed: 0,
            durationMs: undefined,
          },
          tasks: new Map([["appserver", running]]),
          order: ["appserver"],
          spinningTaskIds: new Set(["appserver"]),
          spinnerFrame: 0,
          expandedTaskId: "appserver",
          expandedLines: ["apply log"],
          terminalColumns: 80,
        },
      },
    ]);

    expect(aggregated.order).toHaveLength(2);
    expect(aggregated.tasks.get(aggregated.order[0] ?? "")?.summary).toBe("image built");
    expect(aggregated.tasks.get(aggregated.order[1] ?? "")?.label).toBe("apply appserver");
    expect(aggregated.spinningTaskIds.has(aggregated.order[1] ?? "")).toBe(true);
    expect(aggregated.expandedTaskId).toBe(aggregated.order[1]);
    const expanded = renderLogicalFrame(aggregated).join("\n");
    expect(expanded).toContain("╭─ apply appserver");
    expect(expanded).toContain(`${SPINNER_FRAMES[0]} apply appserver`);
    expect(expanded).not.toContain("\u0000");
  });

  test("keeps an earlier spinning tree's frame when a later tree is static", () => {
    const spinning: TaskState = {
      id: "appserver",
      transcriptPath: undefined,
      label: "build appserver",
      status: "running",
      summary: undefined,
      durationMs: undefined,
      exitCode: undefined,
      remediation: undefined,
      ring: new TaskDetailRing(),
    };
    const done: TaskState = {
      id: "database",
      transcriptPath: undefined,
      label: "database",
      status: "done",
      summary: "database ready",
      durationMs: 10,
      exitCode: undefined,
      remediation: undefined,
      ring: new TaskDetailRing(),
    };
    const treeA = {
      parentId: "build",
      state: {
        tree: {
          parentId: "build",
          childCount: 1,
          label: "Building",
          done: false,
          summary: undefined,
          succeeded: 0,
          failed: 0,
          durationMs: undefined,
        },
        tasks: new Map([["appserver", spinning]]),
        order: ["appserver"],
        spinningTaskIds: new Set(["appserver"]),
        spinnerFrame: 5,
        expandedTaskId: undefined,
        expandedLines: [],
        terminalColumns: 80,
      },
    };
    const treeB = {
      parentId: "apply",
      state: {
        tree: {
          parentId: "apply",
          childCount: 1,
          label: "Applying",
          done: true,
          summary: "Applied",
          succeeded: 1,
          failed: 0,
          durationMs: 10,
        },
        tasks: new Map([["database", done]]),
        order: ["database"],
        spinningTaskIds: new Set<string>(),
        spinnerFrame: 0,
        expandedTaskId: undefined,
        expandedLines: [],
        terminalColumns: 80,
      },
    };
    const first = aggregateRenderState("app:start", [treeA, treeB]);
    expect(renderLogicalFrame(first).join("\n")).toContain(`${SPINNER_FRAMES[5]} build appserver`);
    const advanced = aggregateRenderState("app:start", [
      { ...treeA, state: { ...treeA.state, spinnerFrame: 6 } },
      treeB,
    ]);
    expect(renderLogicalFrame(advanced).join("\n")).toContain(`${SPINNER_FRAMES[6]} build appserver`);
    expect(renderLogicalFrame(advanced).join("\n")).not.toContain(`${SPINNER_FRAMES[0]} build appserver`);
  });

  test("session focus and Enter can expand each duplicate raw taskId independently", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build", "/tmp/lando/builds/appserver.log"));
    collection.consume(taskComplete("appserver", "image built"));
    collection.consume(treeComplete("build", "Built"));
    collection.consume(treeStart("apply", "Applying", ["appserver"]));
    collection.consume(taskStart("appserver", "apply appserver", "apply", "/tmp/lando/apply/appserver.log"));
    collection.consume(taskComplete("appserver", "service applied"));
    collection.consume(treeComplete("apply", "Applied"));

    const ids = collection.focusableTaskIds();
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids).not.toContain("appserver");
    expect(collection.eventTaskId(ids[0] ?? "")).toBe("appserver");
    expect(collection.eventTaskId(ids[1] ?? "")).toBe("appserver");

    const controller = new TaskTreeInputController(collection, { now: () => ts });
    const buildExpand = controller.handleKey("enter");
    expect(buildExpand.events[0]).toMatchObject({ _tag: "task.detail.expand", taskId: "appserver" });
    expect(buildExpand.preferredInternalId).toBe(ids[0]);
    expect(JSON.stringify(buildExpand.events[0])).not.toContain("\u0000");
    expect(collection.expandedTaskId).toBe(ids[0]);
    expect(collection.transcriptPathFor(ids[0] ?? "")).toBe(
      AbsolutePath.make("/tmp/lando/builds/appserver.log"),
    );

    const buildCollapse = controller.handleKey("esc");
    expect(buildCollapse.events[0]).toMatchObject({ _tag: "task.detail.collapse", taskId: "appserver" });
    expect(buildCollapse.preferredInternalId).toBe(ids[0]);
    controller.handleKey("down");
    const applyExpand = controller.handleKey("enter");
    expect(applyExpand.events[0]).toMatchObject({ _tag: "task.detail.expand", taskId: "appserver" });
    expect(applyExpand.preferredInternalId).toBe(ids[1]);
    expect(JSON.stringify(applyExpand.events[0])).not.toContain("\u0000");
    expect(collection.expandedTaskId).toBe(ids[1]);
    expect(collection.transcriptPathFor(ids[1] ?? "")).toBe(
      AbsolutePath.make("/tmp/lando/apply/appserver.log"),
    );
  });

  test("collapse after raw switch returns the command frame with no stale tail", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build", "/tmp/lando/builds/appserver.log"));
    collection.consume(taskComplete("appserver", "image built"));
    collection.consume(treeComplete("build", "Built"));
    collection.consume(treeStart("apply", "Applying", ["appserver"]));
    collection.consume(taskStart("appserver", "apply appserver", "apply", "/tmp/lando/apply/appserver.log"));
    collection.consume(taskComplete("appserver", "service applied"));
    collection.consume(treeComplete("apply", "Applied"));

    const ids = collection.focusableTaskIds();
    collection.expandTask(ids[0] ?? "");
    collection.expandTask("appserver");
    collection.collapse();

    const frame = plainFrame(collection);
    expect(frame).toContain("╭─ app:start");
    expect(frame).not.toContain("╰─ tail");
    expect(collection.expandedTaskId).toBeUndefined();
  });

  test("restoring the first occurrence after a switch shows that task in getter and frame", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build", "/tmp/lando/builds/appserver.log"));
    collection.consume(taskComplete("appserver", "image built"));
    collection.consume(treeComplete("build", "Built"));
    collection.consume(treeStart("apply", "Applying", ["appserver"]));
    collection.consume(taskStart("appserver", "apply appserver", "apply", "/tmp/lando/apply/appserver.log"));
    collection.consume(taskComplete("appserver", "service applied"));
    collection.consume(treeComplete("apply", "Applied"));

    const ids = collection.focusableTaskIds();
    collection.expandTask(ids[0] ?? "");
    collection.expandTask(ids[1] ?? "");
    collection.expandTask(ids[0] ?? "");

    expect(collection.expandedTaskId).toBe(ids[0]);
    const frame = plainFrame(collection);
    expect(frame).toContain("╭─ build appserver");
    expect(frame).not.toContain("╭─ apply appserver");
  });

  test("a later phase tree.start does not drop the active expanded tail", () => {
    const collection = makeCollection();
    collection.openSession("app:start");
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build", "/tmp/lando/builds/appserver.log"));
    collection.consume(taskComplete("appserver", "image built"));
    const buildId = collection.focusableTaskIds()[0] ?? "";
    collection.expandTask(buildId);
    expect(collection.expandedTaskId).toBe(buildId);

    collection.consume(treeStart("apply", "Applying", ["appserver"]));
    collection.consume(taskStart("appserver", "apply appserver", "apply", "/tmp/lando/apply/appserver.log"));

    expect(collection.expandedTaskId).toBe(buildId);
    const frame = plainFrame(collection);
    expect(frame).toContain("╭─ build appserver");
    expect(frame).toContain("╰─ tail");
    expect(frame).not.toContain("╭─ app:start");

    collection.collapse();
    const collapsed = plainFrame(collection);
    expect(collapsed).toContain("╭─ app:start");
    expect(collapsed).not.toContain("╰─ tail");
    expect(collection.expandedTaskId).toBeUndefined();
  });

  test("without a session, expandedTaskId follows the selected tree", () => {
    const collection = makeCollection();
    collection.consume(treeStart("build", "Building", ["appserver"]));
    collection.consume(taskStart("appserver", "build appserver", "build", "/tmp/lando/builds/appserver.log"));
    collection.expandTask("appserver");
    expect(collection.expandedTaskId).toBe("appserver");
    collection.consume(treeStart("apply", "Applying", ["db"]));
    expect(collection.expandedTaskId).toBeUndefined();
  });
});
