import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import type { LandoEvent as PublishedEvent } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { emitToolingOutputProgress } from "../../src/operations/tooling-progress.ts";

const collectPublisher = () => {
  const events: LandoEvent[] = [];
  return {
    events,
    publish: (event: PublishedEvent) =>
      Schema.is(LandoEventSchema)(event)
        ? Effect.sync(() => {
            events.push(event);
          })
        : Effect.die(new TypeError(`Unexpected event in tooling progress test: ${event._tag}`)),
  };
};

const byTag = <T extends LandoEvent["_tag"]>(events: ReadonlyArray<LandoEvent>, tag: T) =>
  events.filter((event): event is Extract<LandoEvent, { readonly _tag: T }> => event._tag === tag);

describe("emitToolingOutputProgress", () => {
  test("publishes prefixed lifecycle, details, and post-hoc duration on success", async () => {
    const publisher = collectPublisher();
    const parentId = "tooling:php";
    const taskId = startChildTaskId(parentId, "appserver");

    await Effect.runPromise(
      emitToolingOutputProgress({
        events: publisher,
        tool: "php",
        service: "appserver",
        stdout: "ok\nready",
        stderr: "warn",
        exitCode: 0,
        durationMs: 87,
      }),
    );

    expect(publisher.events.map((event) => event._tag)).toEqual([
      "task.tree.start",
      "task.start",
      "task.detail",
      "task.detail",
      "task.detail",
      "task.complete",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      children: [taskId],
    });
    expect(byTag(publisher.events, "task.detail").map((event) => event.stream)).toEqual([
      "stdout",
      "stdout",
      "stderr",
    ]);
    expect(byTag(publisher.events, "task.complete")[0]).toMatchObject({
      taskId,
      durationMs: 87,
    });
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      succeeded: 1,
      failed: 0,
      durationMs: 87,
    });
  });

  test("publishes fail with exitCode and post-hoc duration", async () => {
    const publisher = collectPublisher();
    const parentId = "tooling:composer";
    const taskId = startChildTaskId(parentId, "appserver");

    await Effect.runPromise(
      emitToolingOutputProgress({
        events: publisher,
        tool: "composer",
        service: "appserver",
        stdout: "",
        stderr: "missing lock",
        exitCode: 2,
        durationMs: 12,
      }),
    );

    expect(publisher.events.map((event) => event._tag)).toEqual([
      "task.tree.start",
      "task.start",
      "task.detail",
      "task.fail",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.fail")[0]).toMatchObject({
      taskId,
      exitCode: 2,
      durationMs: 12,
    });
    expect(byTag(publisher.events, "task.tree.complete")[0]).toMatchObject({
      parentId,
      succeeded: 0,
      failed: 1,
      durationMs: 12,
    });
  });
});
