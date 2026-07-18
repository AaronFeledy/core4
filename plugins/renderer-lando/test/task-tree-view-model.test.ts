/**
 * TaskTreeViewModel — pure state/view-model contract.
 *
 * The view-model owns the task/tree state machine and the styled frame content.
 * It emits ZERO terminal-control bytes: `frameLines()` returns the styled footer
 * content lines and `snapshot()` returns the logical (unstyled) frame. All
 * cursor-rewind / erase / repaint responsibility moved out to the substrate
 * live region, so "no cursor-up on first paint" is now structural, not asserted.
 */

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskFailEvent,
  TaskStartEvent,
  TaskTreeCompleteEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";

import { TaskTreeViewModel } from "../src/task-tree-tail.ts";

const ts = "2026-05-19T12:00:00.000Z";
const ESC = String.fromCharCode(27);
// Cursor movement / erase control sequences the view-model must never emit.
const cursorUpPattern = new RegExp(`${ESC}\\[[0-9]+A`);
const eraseDownPattern = new RegExp(`${ESC}\\[0J`);
const eraseLinePattern = new RegExp(`${ESC}\\[2K`);

const treeStart = (parentId: string, label: string, children: ReadonlyArray<string>): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeStartEvent)({
    _tag: "task.tree.start",
    parentId,
    label,
    children,
    timestamp: ts,
  });

const taskStart = (taskId: string, label: string, parentId?: string, transcriptPath?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskStartEvent)({
    _tag: "task.start",
    taskId,
    ...(parentId === undefined ? {} : { parentId }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    label,
    timestamp: ts,
  });

const taskDetail = (taskId: string, line: string, stream: "stdout" | "stderr" = "stdout"): LandoEvent =>
  Schema.decodeUnknownSync(TaskDetailEvent)({
    _tag: "task.detail",
    taskId,
    line,
    stream,
    timestamp: ts,
  });

const taskComplete = (taskId: string, summary?: string, durationMs?: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskCompleteEvent)({
    _tag: "task.complete",
    taskId,
    ...(summary === undefined ? {} : { summary }),
    ...(durationMs === undefined ? {} : { durationMs }),
    timestamp: ts,
  });

const taskFail = (taskId: string, summary: string, exitCode: number, remediation?: string): LandoEvent =>
  Schema.decodeUnknownSync(TaskFailEvent)({
    _tag: "task.fail",
    taskId,
    summary,
    exitCode,
    ...(remediation === undefined ? {} : { remediation }),
    timestamp: ts,
  });

const treeComplete = (summary: string, succeeded: number, failed: number): LandoEvent =>
  Schema.decodeUnknownSync(TaskTreeCompleteEvent)({
    _tag: "task.tree.complete",
    parentId: "build",
    summary,
    succeeded,
    failed,
    timestamp: ts,
  });

const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");
const assertNoControlBytes = (lines: ReadonlyArray<string>): void => {
  for (const line of lines) {
    expect(cursorUpPattern.test(line)).toBe(false);
    expect(eraseDownPattern.test(line)).toBe(false);
    expect(eraseLinePattern.test(line)).toBe(false);
    expect(line.includes("\r")).toBe(false);
  }
};

describe("TaskTreeViewModel — apply + frameLines content", () => {
  test("apply(tree.start) yields a skeleton with parent line and pending placeholders; no control bytes", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web", "db", "cache"]));
    const styled = vm.frameLines();
    assertNoControlBytes(styled);
    const plain = styled.map(stripAnsi);
    expect(plain[0]).toContain("LANDO OPS");
    expect(plain[0]).toContain("Building (0/3 running)");
    const placeholders = plain.filter((line) => line.includes("◌"));
    expect(placeholders).toHaveLength(3);
    expect(placeholders[0]).toContain("◌ web");
  });

  test("snapshot() logical frame is unstyled and carries active running task ids", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web", "db"]));
    vm.apply(taskStart("web", "web service", "build"));
    const snap = vm.snapshot();
    assertNoControlBytes(snap.frameLines);
    expect(snap.frameLines.join("\n")).toContain("· web service");
    expect(snap.activeTaskIds).toEqual(["web"]);
  });

  test("running detail lines surface under the running task in frameLines", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web"]));
    vm.apply(taskStart("web", "web service", "build"));
    vm.apply(taskDetail("web", "listening on :80"));
    vm.apply(taskDetail("web", "warn: slow", "stderr"));
    const plain = vm.frameLines().map(stripAnsi).join("\n");
    expect(plain).toContain("listening on :80");
    expect(plain).toContain("! warn: slow");
  });

  test("CJK task content stays within the requested terminal cell width", () => {
    const vm = new TaskTreeViewModel({ terminalColumns: 40 });
    vm.apply(treeStart("build", "한글 애플리케이션 시작 중입니다", ["웹서버"]));
    vm.apply(taskStart("웹서버", "웹서버 런타임을 부팅하는 중", "build"));
    vm.apply(taskDetail("웹서버", "포트 8080 에서 수신 대기 중입니다 지금"));

    for (const line of vm.frameLines().map(stripAnsi))
      expect(Bun.stringWidth(line), `line exceeded 40 cells: ${line}`).toBeLessThanOrEqual(40);
  });

  test("frame lines never exceed terminals narrower than the frame chrome", () => {
    for (let columns = 1; columns <= 6; columns += 1) {
      const vm = new TaskTreeViewModel({ terminalColumns: columns });
      vm.apply(treeStart("build", "Building", ["web"]));
      vm.apply(taskStart("web", "web service", "build"));
      vm.apply(taskDetail("web", "progress"));

      for (const line of vm.frameLines().map(stripAnsi)) {
        expect(Bun.stringWidth(line), `${columns}-column frame overflowed: ${line}`).toBeLessThanOrEqual(
          columns,
        );
      }
    }
  });
});

describe("TaskTreeViewModel — hasAnimatedAffordance (30fps live-gating)", () => {
  test("true only while a running task has a visible spinner", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web"]));
    expect(vm.hasAnimatedAffordance()).toBe(false);
    vm.apply(taskStart("web", "web service", "build"));
    expect(vm.hasAnimatedAffordance()).toBe(false);
    vm.showSpinner("web");
    expect(vm.hasAnimatedAffordance()).toBe(true);
    expect(vm.frameLines().map(stripAnsi).join("\n")).toContain("⠋ web service");
    vm.apply(taskComplete("web", "web ready", 120));
    expect(vm.hasAnimatedAffordance()).toBe(false);
  });
});

describe("TaskTreeViewModel — focus + expand/collapse (state only, no redraw bytes)", () => {
  test("focusable ids exclude pending tasks and include started ones", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["a", "b"]));
    expect(vm.focusableTaskIds()).toEqual([]);
    vm.apply(taskStart("b", "step b", "build"));
    expect(vm.focusableTaskIds()).toEqual(["b"]);
  });

  test("expandTask switches frameLines to the expanded tail; collapse restores the tree; no control bytes", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web"]));
    const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");
    vm.apply(taskStart("web", "web service", "build", transcriptPath));
    vm.apply(taskDetail("web", "boot line"));
    expect(vm.canExpandTask("web")).toBe(true);
    vm.expandTask("web");
    expect(vm.expandedTaskId).toBe("web");
    const expanded = vm.frameLines();
    assertNoControlBytes(expanded);
    expect(expanded.map(stripAnsi).join("\n")).toContain("expanded task tail");
    expect(expanded.map(stripAnsi).join("\n")).not.toContain("boot line");
    expect(vm.transcriptPathFor("web")).toBe(transcriptPath);
    vm.collapse();
    expect(vm.expandedTaskId).toBeUndefined();
    assertNoControlBytes(vm.frameLines());
  });
});

describe("TaskTreeViewModel — new tree replaces prior single-tree state", () => {
  test("a second tree.start drops the prior tree's completed rows, order, spinner, and expanded state", () => {
    const vm = new TaskTreeViewModel();

    // First tree: an artifact build that runs and completes.
    vm.apply(treeStart("build-artifact", "Building artifact", ["artifact-web"]));
    const artifactPath = AbsolutePath.make("/tmp/lando/builds/artifact-web.log");
    vm.apply(taskStart("artifact-web", "artifact web", "build-artifact", artifactPath));
    vm.showSpinner("artifact-web");
    vm.apply(taskComplete("artifact-web", "artifact web built", 90));
    vm.expandTask("artifact-web");
    expect(vm.expandedTaskId).toBe("artifact-web");

    // Second tree: the later apply run must not inherit the prior tree's rows.
    vm.apply(treeStart("apply", "Applying", ["apply-db"]));

    const plain = vm.frameLines().map(stripAnsi).join("\n");
    expect(plain).toContain("Applying (0/1 running)");
    expect(plain).not.toContain("artifact web");
    expect(plain).not.toContain("artifact web built");

    expect(vm.focusableTaskIds()).toEqual([]);
    expect(vm.transcriptPathFor("artifact-web")).toBeUndefined();
    expect(vm.canExpandTask("artifact-web")).toBe(false);
    expect(vm.expandedTaskId).toBeUndefined();
    expect(vm.hasAnimatedAffordance()).toBe(false);
    expect(vm.snapshot().activeTaskIds).toEqual([]);

    const placeholders = vm
      .frameLines()
      .map(stripAnsi)
      .filter((line) => line.includes("◌"));
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toContain("◌ apply-db");
  });
});

describe("TaskTreeViewModel — completion + failure summaries", () => {
  test("failed task renders a blocked summary with exit code and remediation", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["db"]));
    vm.apply(taskStart("db", "database", "build"));
    vm.apply(taskFail("db", "migration failed", 1, "run lando db:reset"));
    const plain = vm.frameLines().map(stripAnsi).join("\n");
    expect(plain).toContain("✗ migration failed");
    expect(plain).toContain("exit 1");
    expect(plain).toContain("run lando db:reset");
  });

  test("tree.complete renders the passive summary footer", () => {
    const vm = new TaskTreeViewModel();
    vm.apply(treeStart("build", "Building", ["web"]));
    vm.apply(taskStart("web", "web service", "build"));
    vm.apply(taskComplete("web", "web ready", 100));
    vm.apply(treeComplete("Build complete", 1, 0));
    const plain = vm.frameLines().map(stripAnsi).join("\n");
    expect(plain).toContain("LANDO OPS");
    expect(plain).toContain("1 ✓");
    assertNoControlBytes(vm.frameLines());
  });
});
