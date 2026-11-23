import { MessageWarnEvent } from "@lando/sdk/events";
import type { CommandWarning } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Context, DateTime, Effect, Option } from "effect";

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

/** Records each warning for machine output and, for people, prints it as a warning message. */
export const publishCommandWarnings = Effect.fnUntraced(function* (warnings: ReadonlyArray<CommandWarning>) {
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = yield* EventService;
  for (const warning of warnings) {
    yield* recordCommandWarning(warning);
    if (!machineOutput) {
      yield* events.publish(
        MessageWarnEvent.make({
          body: `${warning.message} ${warning.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      );
    }
  }
});
