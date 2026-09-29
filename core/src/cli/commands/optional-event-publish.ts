import { EventService } from "@lando/sdk/services";
import { type Context, Effect, Option } from "effect";

export const publishOptionalEvent = (
  event: Parameters<Context.Tag.Service<typeof EventService>["publish"]>[0],
) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      Option.match(events, {
        onSome: (service) => service.publish(event).pipe(Effect.ignore),
        onNone: () => Effect.void,
      }),
    ),
  );
