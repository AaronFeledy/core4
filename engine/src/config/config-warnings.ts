import type { CommandWarning } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";

export const recordConfigWarning = Effect.fnUntraced(function* (warning: CommandWarning) {
  yield* recordCommandWarning(warning);
  const machine = yield* commandWarningsUseMachineOutput;
  const renderer = yield* Effect.serviceOption(Renderer);
  if (!machine && Option.isSome(renderer))
    yield* renderer.value.message.warn(warning.message).pipe(Effect.ignore);
});
