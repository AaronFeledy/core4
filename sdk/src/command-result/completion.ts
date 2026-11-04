import { Schema } from "effect";
import { LandoCommandError } from "../errors/runtime.ts";
import { CommandCompletion } from "../schema/machine-output.ts";
import type { CommandResultOutcome } from "./index.ts";

export type CompletedCommandResult<A> = CommandResultOutcome<A> & {
  readonly value: A;
  readonly exitCode: number;
};

/** Explicit process policy. Arbitrary result fields never imply process status. */
export const commandCompletionFromExitCode = (exitCode: number): CommandCompletion =>
  exitCode === 0 ? { ok: true, exitCode } : { ok: false, exitCode };

/** Invoked once, after producers and their finalizers have finished. */
export const resolveCommandCompletion = <A>(
  commandId: string,
  value: A,
  policy?: (value: A) => CommandCompletion,
): CompletedCommandResult<A> => {
  const completion = Schema.decodeUnknownSync(CommandCompletion)(
    policy === undefined ? { ok: true, exitCode: 0 } : policy(value),
  );
  if (completion.ok) return { _tag: "success", value, exitCode: completion.exitCode };
  return {
    _tag: "failure",
    value,
    exitCode: completion.exitCode,
    error: new LandoCommandError({
      commandId,
      exitCode: completion.exitCode,
      message: `Command ${commandId} completed unsuccessfully (exit ${completion.exitCode}).`,
      remediation: "Inspect the command output, correct the reported problem, then retry.",
    }),
    additionalErrors: [],
  };
};
