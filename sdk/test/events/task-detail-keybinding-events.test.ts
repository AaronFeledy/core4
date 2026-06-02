import { describe, expect, test } from "bun:test";

import { DateTime, Schema } from "effect";

import { LandoEvent, TaskDetailCollapseEvent, TaskDetailExpandEvent } from "@lando/sdk/events";

const FIXED_TIMESTAMP = DateTime.unsafeMake("2026-05-11T07:30:00Z");
const timestamp = DateTime.formatIso(FIXED_TIMESTAMP);

describe("task.detail.expand / task.detail.collapse events", () => {
  test("TaskDetailExpandEvent decodes a taskId + timestamp payload", () => {
    const decoded = Schema.decodeUnknownSync(TaskDetailExpandEvent)({
      _tag: "task.detail.expand",
      taskId: "appserver",
      timestamp,
    });
    expect(decoded._tag).toBe("task.detail.expand");
    expect(decoded.taskId).toBe("appserver");
  });

  test("TaskDetailCollapseEvent decodes a taskId + timestamp payload", () => {
    const decoded = Schema.decodeUnknownSync(TaskDetailCollapseEvent)({
      _tag: "task.detail.collapse",
      taskId: "node",
      timestamp,
    });
    expect(decoded._tag).toBe("task.detail.collapse");
    expect(decoded.taskId).toBe("node");
  });

  test("both events are members of the LandoEvent union", () => {
    const expand = Schema.decodeUnknownSync(LandoEvent)({
      _tag: "task.detail.expand",
      taskId: "appserver",
      timestamp,
    });
    const collapse = Schema.decodeUnknownSync(LandoEvent)({
      _tag: "task.detail.collapse",
      taskId: "appserver",
      timestamp,
    });
    expect(expand._tag).toBe("task.detail.expand");
    expect(collapse._tag).toBe("task.detail.collapse");
  });
});
