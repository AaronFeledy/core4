import { expect, test } from "bun:test";
import * as LandoEventService from "@lando/engine/services/event-service";

import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { publishTaskStart } from "@lando/sdk/task-progress";
import { Effect, Queue } from "effect";

test("publishTaskStart threads the optional transcript path", async () => {
  const transcriptPath = AbsolutePath.make("/tmp/lando/builds/web.log");

  const first = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* EventService;
        const queue = yield* events.subscribeQueue;
        yield* publishTaskStart(events, {
          taskId: "build:web",
          label: "Build web",
          transcriptPath,
        });
        return yield* Queue.take(queue);
      }).pipe(Effect.provide(LandoEventService.layer)),
    ),
  );

  expect(first._tag === "task.start" && first.transcriptPath).toBe(transcriptPath);
});
