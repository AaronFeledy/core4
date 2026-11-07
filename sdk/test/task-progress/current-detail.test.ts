import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";

import type { LandoEvent } from "@lando/sdk/services";
import { CurrentTaskDetail, makeTaskTree, withCurrentTaskDetail } from "@lando/sdk/task-progress";

test("task detail bindings isolate concurrent children, restore nested bindings, and stop after settlement", async () => {
  const events: LandoEvent[] = [];
  const tree = makeTaskTree(
    {
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
    },
    {
      parentId: "setup",
      label: "Setup",
      children: [
        { id: "left", label: "Left" },
        { id: "right", label: "Right" },
      ],
    },
  );
  const publish = (line: string) =>
    Effect.gen(function* () {
      const sink = yield* CurrentTaskDetail;
      if (sink !== undefined) yield* sink(line);
    });
  let retained: ((line: string) => Effect.Effect<void>) | undefined;
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* tree.start;
      yield* tree.startTask("left");
      yield* tree.startTask("right");
      const ready = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const left = yield* Effect.forkChild(
        withCurrentTaskDetail(
          tree,
          "left",
          Effect.gen(function* () {
            retained = yield* CurrentTaskDetail;
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(proceed);
            yield* publish("left");
            yield* withCurrentTaskDetail(tree, "right", publish("nested"));
            yield* publish("restored");
            yield* tree.completeTask("left");
            yield* publish("after settlement");
          }),
        ),
      );
      yield* Deferred.await(ready);
      yield* withCurrentTaskDetail(tree, "right", publish("right"));
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(left);
      if (retained !== undefined) yield* retained("after binding");
      expect(yield* CurrentTaskDetail).toBeUndefined();
    }),
  );
  expect(
    events
      .filter((event) => event._tag === "task.detail")
      .map((event) => [event.taskId, event.stream, event.line]),
  ).toEqual([
    ["right", "stderr", "right"],
    ["left", "stderr", "left"],
    ["right", "stderr", "nested"],
    ["left", "stderr", "restored"],
  ]);
});
