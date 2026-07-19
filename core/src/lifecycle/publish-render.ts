import { type Context, Effect, Schema } from "effect";

import { EventError } from "@lando/sdk/errors";
import { RenderEvent } from "@lando/sdk/events";
import type { PublishRender } from "@lando/sdk/plugins";
import type { EventService } from "@lando/sdk/services";

import type { RedactionServiceShape } from "../redaction/service.ts";

export const makePublishRender =
  (events: Context.Tag.Service<typeof EventService>, redaction: RedactionServiceShape): PublishRender =>
  (event) =>
    Effect.gen(function* () {
      const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
      const decoded = yield* Schema.decodeUnknown(RenderEvent)(redactor.redactValue(event)).pipe(
        Effect.mapError(
          (cause) =>
            new EventError({
              event: event._tag,
              message: `Plugin render event failed schema decoding: ${event._tag}`,
              cause,
            }),
        ),
      );
      yield* events.publish(decoded);
    });
