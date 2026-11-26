/**
 * Settles one command run with the teardown of its runtime, so the boundary
 * writes exactly one terminal result after every owned finalizer has run.
 */

import { type CompletedCommandResult, mergeFailure } from "@lando/sdk/command-result";
import type { DeprecationUse } from "@lando/sdk/schema";
import { Cause, Exit } from "effect";
import type { TerminalWrite } from "./terminal-document";

/** What a command's own human render wrote, in order, captured in scope and written with the terminal document. */
export type RenderedOutput = ReadonlyArray<TerminalWrite>;

/** What the command run produced inside its runtime scope, before teardown. */
export type CommandRun<A> =
  /** Nothing more is written: the reader went away, or the caller owns the interruption. */
  | { readonly _tag: "silent"; readonly reason: "broken-pipe" | "interruption" }
  | {
      readonly _tag: "completed";
      readonly completed: CompletedCommandResult<A>;
      readonly deprecations: ReadonlyArray<DeprecationUse>;
      readonly proxyDefaultDomain?: string;
      readonly rendered?: RenderedOutput;
    }
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<unknown>;
      readonly deprecations: ReadonlyArray<DeprecationUse>;
    };

/** A completed result a teardown failure turned into a failure, kept for the report. */
export interface RetainedResult<A> {
  readonly value: A;
  /** The run's own exit status, which an additional cleanup error never changes. */
  readonly exitCode?: number;
  readonly rendered?: RenderedOutput;
}

/** The single outcome the boundary reports. */
export type SettledCommand<A> =
  | { readonly _tag: "silent" }
  | Extract<CommandRun<A>, { readonly _tag: "completed" }>
  | {
      readonly _tag: "failed";
      readonly cause: Cause.Cause<unknown>;
      readonly deprecations: ReadonlyArray<DeprecationUse>;
      readonly retained?: RetainedResult<A>;
    };

const completedCause = <A>(completed: CompletedCommandResult<A>): Cause.Cause<unknown> | undefined => {
  switch (completed._tag) {
    case "success":
      return undefined;
    case "failure":
      return Cause.fail(completed.error);
    default:
      return completed satisfies never;
  }
};

/**
 * A teardown failure is the primary error of a run that succeeded, and a
 * `cleanup` additional error of a run that failed; it never changes the run's
 * own exit status.
 */
export const settleCommandRun = <A>(
  run: Exit.Exit<CommandRun<A>, unknown>,
  teardown: Exit.Exit<void, unknown>,
): SettledCommand<A> => {
  const teardownCause = Exit.isFailure(teardown) ? teardown.cause : undefined;
  if (Exit.isFailure(run)) {
    return {
      _tag: "failed",
      cause: teardownCause === undefined ? run.cause : mergeFailure(run.cause, teardownCause, "cleanup"),
      deprecations: [],
    };
  }
  const outcome = run.value;
  if (teardownCause === undefined) return outcome._tag === "silent" ? { _tag: "silent" } : outcome;
  switch (outcome._tag) {
    case "silent":
      return outcome.reason === "broken-pipe"
        ? { _tag: "silent" }
        : { _tag: "failed", cause: teardownCause, deprecations: [] };
    case "failed":
      return { ...outcome, cause: mergeFailure(outcome.cause, teardownCause, "cleanup") };
    case "completed": {
      const { completed, rendered } = outcome;
      const commandCause = completedCause(completed);
      return {
        _tag: "failed",
        cause:
          commandCause === undefined ? teardownCause : mergeFailure(commandCause, teardownCause, "cleanup"),
        deprecations: outcome.deprecations,
        retained: {
          value: completed.value,
          ...(commandCause === undefined ? {} : { exitCode: completed.exitCode }),
          ...(rendered === undefined ? {} : { rendered }),
        },
      };
    }
    default:
      return outcome satisfies never;
  }
};
