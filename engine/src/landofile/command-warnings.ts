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

const sameWarning = (left: CommandWarning, right: CommandWarning): boolean =>
  left.code === right.code &&
  Object.entries(left.context ?? {}).length === Object.entries(right.context ?? {}).length &&
  Object.entries(left.context ?? {}).every(([key, value]) => right.context?.[key] === value);

/**
 * Record a warning unless this command already recorded one with the same code and context.
 * True when it was recorded, so the caller tells people about it only once per command. Without a
 * command scope there is nothing to dedupe against, so it reports true.
 */
export const recordCommandWarningOnce = (warning: CommandWarning): Effect.Effect<boolean> =>
  Effect.serviceOption(CommandWarnings).pipe(
    Effect.flatMap((service) => {
      if (Option.isNone(service)) return Effect.succeed(true);
      return service.value.list.pipe(
        Effect.flatMap((recorded) =>
          recorded.some((entry) => sameWarning(entry, warning))
            ? Effect.succeed(false)
            : service.value.add(warning).pipe(Effect.as(true)),
        ),
      );
    }),
  );

export const commandWarningsUseMachineOutput: Effect.Effect<boolean> = Effect.serviceOption(
  CommandWarnings,
).pipe(Effect.map((service) => (Option.isSome(service) ? service.value.machineOutput : false)));

/** A warning's identity: its code plus the context naming its source, or its message without one. */
const commandWarningKey = (warning: CommandWarning): string =>
  JSON.stringify([
    warning.code,
    warning.context === undefined
      ? warning.message
      : Object.entries(warning.context).sort(([left], [right]) => left.localeCompare(right)),
  ]);

/**
 * Records each warning for machine output and, for people, prints it as a warning message.
 * A warning this command already recorded is skipped, so nested or resumed operations that
 * publish for the same plan report it once.
 */
export const publishCommandWarnings = Effect.fnUntraced(function* (warnings: ReadonlyArray<CommandWarning>) {
  const service = yield* Effect.serviceOption(CommandWarnings);
  const machineOutput = Option.isSome(service) && service.value.machineOutput;
  const seen = new Set(Option.isSome(service) ? (yield* service.value.list).map(commandWarningKey) : []);
  const events = yield* EventService;
  for (const warning of warnings) {
    const key = commandWarningKey(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    if (Option.isSome(service)) yield* service.value.add(warning);
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
