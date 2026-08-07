import { Effect } from "effect";

import { type InteractionError, InteractionService } from "@lando/sdk/services";

export const confirmRemoteSyncWithInteraction = (
  message: string,
): Effect.Effect<boolean | undefined, InteractionError> =>
  Effect.serviceOption(InteractionService).pipe(
    Effect.flatMap((interaction) =>
      interaction._tag === "None"
        ? Effect.succeed(undefined)
        : Effect.scoped(interaction.value.confirm({ message, default: false, mode: "interactive" })),
    ),
  );
