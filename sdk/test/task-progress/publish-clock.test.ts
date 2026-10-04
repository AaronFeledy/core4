import { expect, test } from "bun:test";
import { TaskDetailEvent } from "@lando/sdk/events";
import { publishTaskDetail } from "@lando/sdk/task-progress";
import { DateTime, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

test("task detail timestamps use the execution clock rather than construction time", async () => {
  // Given
  const events: TaskDetailEvent[] = [];
  const detail = publishTaskDetail(
    {
      publish: (event) =>
        Effect.sync(() => {
          if (!Schema.is(TaskDetailEvent)(event)) throw new TypeError("Expected a task detail event");
          events.push(event);
        }),
    },
    { taskId: "task", stream: "stdout", line: "detail" },
  );
  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(123456789);
      yield* detail;
    }).pipe(Effect.provide(TestClock.layer())),
  );
  // Then
  expect(events).toHaveLength(1);
  expect(events.map((event) => DateTime.toEpochMillis(event.timestamp))).toEqual([123456789]);
});
