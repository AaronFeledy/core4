import { Context, type Effect } from "effect";

/** Per-invocation confirmation supplied by a non-terminal host. */
export class ConfirmationPrompt extends Context.Service<
  ConfirmationPrompt,
  {
    readonly confirm: (request: { readonly message: string }) => Effect.Effect<"accepted" | "declined">;
  }
>()("@lando/engine/ConfirmationPrompt") {}
