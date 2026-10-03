import { ConfirmationPrompt } from "@lando/engine/operations/confirmation-prompt";
import type { Redactor } from "@lando/sdk/secrets";
import { Duration, Effect, Option } from "effect";
import { McpServerClient } from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";

export const ELICITATION_TIMEOUT = Duration.seconds(120);

const elicitConfirmation = Effect.fn("McpService.elicitConfirmation")(
  function* (message: string) {
    const session = yield* McpServerClient;
    const client = yield* session.getClient;
    const response = yield* client.elicit({
      mode: "form",
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Confirm", description: "Approve this operation." },
        },
        required: ["confirm"],
      },
    });
    switch (response.action) {
      case "accept":
        return response.content?.confirm === true ? ("accepted" as const) : ("declined" as const);
      case "decline":
      case "cancel":
        return "declined" as const;
    }
  },
  Effect.timeoutOrElse({ duration: ELICITATION_TIMEOUT, orElse: () => Effect.succeed("declined" as const) }),
  Effect.catch(() => Effect.succeed("declined" as const)),
  Effect.scoped,
);

/** The tool call a confirmation belongs to; the elicitation message names both. */
export interface ConfirmationTarget {
  readonly toolId: string;
  /** Directory of the app the call targets. */
  readonly app: string;
}

export const confirmationPrompt = Effect.fnUntraced(function* (
  target: ConfirmationTarget,
  redactor: Redactor,
) {
  const capabilities = yield* McpServer.clientCapabilities;
  if (capabilities.elicitation === undefined) return Option.none<ConfirmationPrompt["Service"]>();
  const session = yield* Effect.serviceOption(McpServerClient);
  if (Option.isNone(session)) return Option.none<ConfirmationPrompt["Service"]>();
  return Option.some(
    ConfirmationPrompt.of({
      confirm: ({ message }) =>
        elicitConfirmation(
          redactor.redactString(`${target.toolId} on the app at ${target.app}: ${message}`),
        ).pipe(Effect.provideService(McpServerClient, session.value)),
    }),
  );
});
