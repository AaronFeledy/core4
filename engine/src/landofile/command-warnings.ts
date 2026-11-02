import { Context, Effect, Option } from "effect";

import type { CommandWarning } from "@lando/sdk/schema";

export interface CommandWarningsShape {
  readonly machineOutput: boolean;
  readonly add: (warning: CommandWarning) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<CommandWarning>>;
  /** Human-only notices the CLI prints after a failed command's error report. */
  readonly addFailureNotice: (body: string) => Effect.Effect<void>;
  readonly failureNotices: Effect.Effect<ReadonlyArray<string>>;
}

export class CommandWarnings extends Context.Service<CommandWarnings, CommandWarningsShape>()(
  "@lando/core/CommandWarnings",
) {}

export const makeCommandWarnings = (machineOutput: boolean): CommandWarningsShape => {
  const warnings: CommandWarning[] = [];
  const failureNotices: string[] = [];
  return {
    machineOutput,
    add: (warning) =>
      Effect.sync(() => {
        warnings.push(warning);
      }),
    list: Effect.sync(() => [...warnings]),
    addFailureNotice: (body) =>
      Effect.sync(() => {
        failureNotices.push(body);
      }),
    failureNotices: Effect.sync(() => [...failureNotices]),
  };
};

export const recordCommandWarning = (warning: CommandWarning): Effect.Effect<void> =>
  Effect.serviceOption(CommandWarnings).pipe(
    Effect.flatMap((service) => (Option.isSome(service) ? service.value.add(warning) : Effect.void)),
  );

export const commandWarningsUseMachineOutput: Effect.Effect<boolean> = Effect.serviceOption(
  CommandWarnings,
).pipe(Effect.map((service) => (Option.isSome(service) ? service.value.machineOutput : false)));
