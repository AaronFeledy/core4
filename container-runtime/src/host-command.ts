/**
 * One best-effort host command for identity lookups.
 *
 * Only a clean exit yields text; every other outcome is "could not tell", which
 * the callers below turn into an absent identity rather than an error.
 */
import type { ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect, Option } from "effect";

export type HelperProcessRunner = Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;

export interface HostCommand {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  /** Overrides layered onto the inherited host environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export const runHostText = (
  runner: Option.Option<HelperProcessRunner>,
  command: HostCommand,
): Effect.Effect<string | undefined> => {
  if (Option.isNone(runner)) return Effect.succeed(undefined);
  return runner.value
    .run({
      cmd: command.cmd,
      args: command.args,
      ...(command.env === undefined ? {} : { env: command.env }),
      timeoutMs: command.timeoutMs,
      capture: true,
    })
    .pipe(
      Effect.map((result: ProcessResult) => (result.exitCode === 0 ? result.stdout : undefined)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
};
