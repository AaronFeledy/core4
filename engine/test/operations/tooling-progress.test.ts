import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { type LandoEvent, LandoEvent as LandoEventSchema } from "@lando/sdk/events";
import type { LandoEvent as PublishedEvent } from "@lando/sdk/services";
import { startChildTaskId } from "@lando/sdk/task-progress";
import { beginLiveToolingTree } from "../../src/operations/tooling-progress.ts";

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

describe("beginLiveToolingTree", () => {
  test("publishes prefixed lifecycle without body detail on success", async () => {
    const publisher = collectPublisher();
    const parentId = "tooling:php";
    const taskId = startChildTaskId(parentId, "exec");

    const tree = beginLiveToolingTree(publisher, "php");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.finish(0, 87);
      }),
    );

    expect(publisher.events.map((event) => event._tag)).toEqual([
      "task.tree.start",
      "task.start",
      "task.complete",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.tree.start")[0]).toMatchObject({
      parentId,
      children: [taskId],
    });
    expect(byTag(publisher.events, "task.detail")).toEqual([]);
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

  test("publishes fail with exitCode and duration without body detail", async () => {
    const publisher = collectPublisher();
    const parentId = "tooling:composer";
    const taskId = startChildTaskId(parentId, "exec");

    const tree = beginLiveToolingTree(publisher, "composer");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* tree.start;
        yield* tree.finish(2, 12);
      }),
    );

    expect(publisher.events.map((event) => event._tag)).toEqual([
      "task.tree.start",
      "task.start",
      "task.fail",
      "task.tree.complete",
    ]);
    expect(byTag(publisher.events, "task.detail")).toEqual([]);
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
