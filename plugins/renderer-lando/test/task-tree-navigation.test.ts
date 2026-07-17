import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import {
  type LandoEvent,
  TaskCompleteEvent,
  TaskDetailEvent,
  TaskStartEvent,
  TaskTreeStartEvent,
} from "@lando/sdk/events";

import { DEFAULT_KEYMAP, TaskTreeInputController, parseKey } from "../src/keybindings.ts";
import { TaskTreeViewModel } from "../src/task-tree-tail.ts";

const timestamp = "2026-05-19T12:00:00.000Z";

const event = (value: Readonly<Record<string, unknown>>): LandoEvent => {
  switch (value._tag) {
    case "task.tree.start":
      return Schema.decodeUnknownSync(TaskTreeStartEvent)(value);
    case "task.start":
      return Schema.decodeUnknownSync(TaskStartEvent)(value);
    case "task.detail":
      return Schema.decodeUnknownSync(TaskDetailEvent)(value);
    case "task.complete":
      return Schema.decodeUnknownSync(TaskCompleteEvent)(value);
    default:
      throw new TypeError(`Unsupported test event: ${String(value._tag)}`);
  }
};

const completedTask = (): TaskTreeViewModel => {
  const viewModel = new TaskTreeViewModel({ terminalRows: 8 });
  viewModel.apply(
    event({ _tag: "task.tree.start", parentId: "build", label: "Building", children: ["web"], timestamp }),
  );
  viewModel.apply(event({ _tag: "task.start", taskId: "web", label: "web", timestamp }));
  for (let index = 0; index < 8; index += 1) {
    viewModel.apply(
      event({ _tag: "task.detail", taskId: "web", stream: "stdout", line: `line-${index}`, timestamp }),
    );
  }
  viewModel.apply(event({ _tag: "task.complete", taskId: "web", summary: "web ready", timestamp }));
  return viewModel;
};

describe("task-tree full-tail navigation", () => {
  test("PgUp and PgDn decode to their default paging actions", () => {
    expect(parseKey("\x1b[5~")).toBe("page-up");
    expect(parseKey("\x1b[6~")).toBe("page-down");
    expect(DEFAULT_KEYMAP["page-up"]).toBe("detail.page-up");
    expect(DEFAULT_KEYMAP["page-down"]).toBe("detail.page-down");
  });

  test("a completed task remains expandable and pages through its retained full tail", () => {
    const viewModel = completedTask();
    const controller = new TaskTreeInputController(viewModel, { now: () => timestamp });

    const expanded = controller.handleKey("enter");
    expect(expanded.events[0]?._tag).toBe("task.detail.expand");
    expect(viewModel.snapshot().frameLines.join("\n")).toContain("line-7");

    expect(controller.handleKey("page-up").changed).toBe(true);
    const olderPage = viewModel.snapshot().frameLines.join("\n");
    expect(olderPage).toContain("line-0");
    expect(olderPage).not.toContain("line-7");

    expect(controller.handleKey("page-down").changed).toBe(true);
    expect(viewModel.snapshot().frameLines.join("\n")).toContain("line-7");
  });
});
