import { type FailureOutcome, failureOutcomeFromCause, normalizeDefect } from "@lando/sdk/command-result";
import { Cause, Schema } from "effect";

export class CommandInterruptedError extends Schema.TaggedError<CommandInterruptedError>()(
  "CommandInterruptedError",
  {
    message: Schema.String,
    remediation: Schema.String,
    signal: Schema.optional(Schema.Literals(["SIGINT", "SIGTERM", "SIGHUP"])),
  },
) {}

const interruptionSignal = (signal?: AbortSignal): "SIGINT" | "SIGTERM" | "SIGHUP" | undefined =>
  signal?.aborted === true &&
  (signal.reason === "SIGINT" || signal.reason === "SIGTERM" || signal.reason === "SIGHUP")
    ? signal.reason
    : undefined;

/** Read at failure time: the signal may have been live when dispatch began. */
export const commandInterruptionExitCode = (signal?: AbortSignal): number => {
  const received = interruptionSignal(signal);
  switch (received) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
    case undefined:
      return 1;
  }
};

/** Presentation only; the original Cause remains available to tracing and callers. */
export const commandFailureOutcome = (cause: Cause.Cause<unknown>, signal?: AbortSignal): FailureOutcome => {
  const failure = failureOutcomeFromCause(cause, normalizeDefect);
  if (failure.kind !== "none" || !Cause.hasInterruptsOnly(cause)) return failure;
  const received = interruptionSignal(signal);
  return {
    ...failure,
    error: new CommandInterruptedError({
      message: "Command interrupted.",
      remediation: "Run the command again when ready.",
      ...(received === undefined ? {} : { signal: received }),
    }),
  };
};
