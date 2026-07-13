import { Context, Effect, Option } from "effect";

import type { CommandWarning } from "@lando/sdk/schema";

export interface CommandWarningsShape {
  readonly machineOutput: boolean;
  readonly add: (warning: CommandWarning) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<CommandWarning>>;
}

export class CommandWarnings extends Context.Tag("@lando/core/CommandWarnings")<
  CommandWarnings,
  CommandWarningsShape
>() {}

export const makeCommandWarnings = (machineOutput: boolean): CommandWarningsShape => {
  const warnings: CommandWarning[] = [];
  return {
    machineOutput,
    add: (warning) =>
      Effect.sync(() => {
        warnings.push(warning);
      }),
    list: Effect.sync(() => [...warnings]),
  };
};

export const recordCommandWarning = (warning: CommandWarning): Effect.Effect<void> =>
  Effect.serviceOption(CommandWarnings).pipe(
    Effect.flatMap((service) => (Option.isSome(service) ? service.value.add(warning) : Effect.void)),
  );

export const commandWarningsUseMachineOutput: Effect.Effect<boolean> = Effect.serviceOption(
  CommandWarnings,
).pipe(Effect.map((service) => (Option.isSome(service) ? service.value.machineOutput : false)));
