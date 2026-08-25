/**
 * TaskTreeAnimationController — delayed braille spinner vs task.detail.
 *
 * Detail is activity, not completion. A running task's pending 100ms timer
 * and active 34ms frames must survive streamed task.detail events. Only
 * terminal task/tree events and dispose settle animation and balance live.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Schema } from "effect";

import {
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import type { LandoEvent } from "@lando/sdk/services";

import { TaskTreeAnimationController } from "../src/task-tree-animation.ts";
import { TaskTreeViewModel } from "../src/task-tree-tail.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
const SPINNER_THRESHOLD_MS = 100;
const SPINNER_FRAME_MS = 34;

const treeStart = (parentId: string, label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });

const taskStart = (taskId: string, label: string, parentId?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    ...(parentId === undefined ? {} : { parentId }),
    label,
    timestamp: ts,
  });

const taskDetail = (taskId: string, line: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    line,
    stream: "stdout",
    timestamp: ts,
  });

const taskComplete = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    summary: `${taskId} ready`,
    durationMs: 120,
    timestamp: ts,
  });

const taskFail = (taskId: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    summary: `${taskId} failed`,
    exitCode: 1,
    timestamp: ts,
  });

const treeComplete = (): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "build",
    summary: "Build complete",
    succeeded: 1,
    failed: 0,
    timestamp: ts,
  });

const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");

const plainFrame = (viewModel: TaskTreeViewModel): string => viewModel.frameLines().map(stripAnsi).join("\n");

describe("TaskTreeAnimationController — task.detail is activity", () => {
  let viewModel: TaskTreeViewModel;
  let animation: TaskTreeAnimationController;
  let calls: { render: number; requestLive: number; dropLive: number };

  const drive = (event: LandoEvent): void => {
    viewModel.apply(event);
    animation.consume(event);
  };

  const startRunningWeb = (): void => {
    drive(treeStart("build", "Building", ["web"]));
    drive(taskStart("web", "web service", "build"));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    viewModel = new TaskTreeViewModel();
    calls = { render: 0, requestLive: 0, dropLive: 0 };
    animation = new TaskTreeAnimationController(viewModel, {
      render: () => {
        calls.render += 1;
      },
      requestLive: () => {
        calls.requestLive += 1;
      },
      dropLive: () => {
        calls.dropLive += 1;
      },
    });
  });

  afterEach(() => {
    animation.dispose();
    jest.useRealTimers();
  });

  test("keeps a pending spinner timer when task.detail streams", () => {
    // Given: a running task whose 100ms anti-flicker timer has not fired
    startRunningWeb();
    expect(viewModel.hasAnimatedAffordance()).toBe(false);

    // When: a detail line arrives before the spinner threshold
    drive(taskDetail("web", "compiling assets"));

    // Then: the detail tail is visible and the pending timer still fires at 100ms
    expect(plainFrame(viewModel)).toContain("compiling assets");
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    expect(calls.requestLive).toBe(0);
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS - 1);
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(viewModel.hasAnimatedAffordance()).toBe(true);
    expect(plainFrame(viewModel)).toContain("⠋ web service");
    expect(plainFrame(viewModel)).toContain("compiling assets");
    expect(calls.requestLive).toBe(1);
    expect(calls.dropLive).toBe(0);
  });

  test("keeps an active spinner visible when task.detail streams", () => {
    // Given: a running task whose delayed spinner is already live
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    expect(viewModel.hasAnimatedAffordance()).toBe(true);
    expect(calls.requestLive).toBe(1);

    // When: a detail line arrives while the spinner is active
    drive(taskDetail("web", "linking objects"));

    // Then: the spinner stays visible, live is not dropped, and the detail tail updates
    expect(viewModel.hasAnimatedAffordance()).toBe(true);
    expect(plainFrame(viewModel)).toContain("⠋ web service");
    expect(plainFrame(viewModel)).toContain("linking objects");
    expect(calls.requestLive).toBe(1);
    expect(calls.dropLive).toBe(0);
  });

  test("keeps the 34ms frame cadence when task.detail streams", () => {
    // Given: an active spinner with its 34ms frame timer running
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    const rendersAfterSpin = calls.render;

    // When: a detail line arrives
    drive(taskDetail("web", "emitting chunks"));

    // Then: the next animation tick still advances and renders
    jest.advanceTimersByTime(SPINNER_FRAME_MS);
    expect(viewModel.hasAnimatedAffordance()).toBe(true);
    expect(calls.render).toBeGreaterThan(rendersAfterSpin);
    expect(calls.dropLive).toBe(0);
  });

  test("stops animation and balances live when task.complete settles", () => {
    // Given: an active spinner holding a live region
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    expect(calls.requestLive).toBe(1);

    // When: the task completes
    drive(taskComplete("web"));

    // Then: animation stops and requestLive/dropLive are balanced
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    expect(calls.dropLive).toBe(1);
    expect(calls.requestLive).toBe(calls.dropLive);
  });

  test("stops animation and balances live when task.fail settles", () => {
    // Given: an active spinner holding a live region
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    expect(calls.requestLive).toBe(1);

    // When: the task fails
    drive(taskFail("web"));

    // Then: animation stops and requestLive/dropLive are balanced
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    expect(calls.dropLive).toBe(1);
    expect(calls.requestLive).toBe(calls.dropLive);
  });

  test("stops animation and balances live when task.tree.complete settles", () => {
    // Given: an active spinner holding a live region
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    expect(calls.requestLive).toBe(1);

    // When: the tree completes
    drive(treeComplete());

    // Then: animation stops and requestLive/dropLive are balanced
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    expect(calls.dropLive).toBe(1);
    expect(calls.requestLive).toBe(calls.dropLive);
  });

  test("stops animation and balances live when disposed", () => {
    // Given: an active spinner holding a live region
    startRunningWeb();
    jest.advanceTimersByTime(SPINNER_THRESHOLD_MS);
    expect(calls.requestLive).toBe(1);

    // When: the controller is disposed
    animation.dispose();

    // Then: animation stops and requestLive/dropLive are balanced
    expect(viewModel.hasAnimatedAffordance()).toBe(false);
    expect(calls.dropLive).toBe(1);
    expect(calls.requestLive).toBe(calls.dropLive);
  });
});
