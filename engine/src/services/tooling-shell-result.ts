import { mapFailures } from "@lando/sdk/command-result";
import { ShellExecError } from "@lando/sdk/errors";
import { Cause, Effect } from "effect";

/** A shell status is completion only when it is the sole reason the shell failed. */
export const recoverToolingShellResult =
  <E, E2>(wrap: (error: E) => E2) =>
  <A, R>(execution: Effect.Effect<A, E, R>) =>
    execution.pipe(
      Effect.catchCause((cause) => {
        const [reason] = cause.reasons;
        if (
          cause.reasons.length === 1 &&
          reason !== undefined &&
          Cause.isFailReason(reason) &&
          reason.error instanceof ShellExecError &&
          reason.error.exitCode !== undefined
        ) {
          return Effect.succeed({
            exitCode: reason.error.exitCode,
            stdout: reason.error.stdout ?? "",
            stderr: reason.error.stderr ?? "",
          });
        }
        return Effect.failCause(cause);
      }),
      mapFailures(wrap),
    );
