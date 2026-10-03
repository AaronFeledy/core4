import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import { InteractionService } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";

export class CommandConfirmationError extends Schema.TaggedError<CommandConfirmationError>()(
  "CommandConfirmationError",
  {
    message: Schema.String,
    remediation: Schema.String,
    reason: Schema.Literals(["declined", "non-interactive"]),
  },
) {}

export const requireConfirmation = (options: { readonly yes: boolean; readonly message: string }) =>
  Effect.gen(function* () {
    if (options.yes) return;
    const prompt = yield* Effect.serviceOption(ConfirmationPrompt);
    if (Option.isSome(prompt)) {
      const answer = yield* prompt.value.confirm({ message: options.message });
      if (answer === "accepted") return;
      return yield* new CommandConfirmationError({
        reason: "declined",
        message: "Command cancelled. The app was not changed.",
        remediation: "Re-run and confirm, or pass --yes.",
      });
    }
    const interaction = yield* Effect.serviceOption(InteractionService);
    if (Option.isNone(interaction) || !(yield* interaction.value.isInteractive)) {
      return yield* new CommandConfirmationError({
        reason: "non-interactive",
        message: "This command requires confirmation before changing the app.",
        remediation: "Re-run with --yes in non-interactive mode.",
      });
    }
    const confirmed = yield* interaction.value
      .confirm({ message: options.message, default: false })
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!confirmed) {
      return yield* new CommandConfirmationError({
        reason: "declined",
        message: "Command cancelled. The app was not changed.",
        remediation: "Re-run and confirm, or pass --yes.",
      });
    }
  }).pipe(Effect.scoped);
