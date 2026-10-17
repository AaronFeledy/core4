import { type Context, Effect } from "effect";
import type { Renderer } from "../services/index.ts";

export interface InteractionContractRenderer {
  readonly service: Context.Service.Shape<typeof Renderer>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export const makeInteractionContractRenderer = (id = "plain"): InteractionContractRenderer => {
  let out = "";
  let err = "";
  return {
    stdout: () => out,
    stderr: () => err,
    service: {
      id,
      capabilities: { color: false, interactive: false, animation: false, notifications: false },
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: {
        stdout: (chunk: string) =>
          Effect.sync(() => {
            out += chunk;
          }),
        stderr: (chunk: string) =>
          Effect.sync(() => {
            err += chunk;
          }),
      },
    },
  };
};
