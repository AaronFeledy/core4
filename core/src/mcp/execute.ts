/**
 * MCP retained-runtime command execution seam.
 *
 * `makeNestedExecute` is the `McpExecute` the dispatch loop hands each tool
 * call: it runs a resolved command as a NESTED invocation against the session's
 * single retained runtime (`runtimeContext`) and the per-request stream sink,
 * translating the command lifecycle `Exit` into a `CommandResultOutcome`.
 * Interrupts (cancellation) propagate; this seam must not swallow them.
 */
import { Cause, type Context, Effect, type Exit } from "effect";

import { makeNestedCommandInvocation, runCommandLifecycle } from "../cli/command-lifecycle.ts";
import type { CommandResultOutcome } from "../cli/result-encode.ts";
import { StreamFrameSink } from "../cli/stream-frame-sink.ts";
import { RuntimeCwd } from "../runtime/cwd.ts";
import type { McpExecute } from "./dispatch.ts";

export const outcomeFromExit = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<CommandResultOutcome> => {
  if (exit._tag === "Success") {
    return Effect.succeed({ _tag: "success", value: exit.value } satisfies CommandResultOutcome);
  }
  if (Cause.isInterruptedOnly(exit.cause)) return Effect.interrupt;
  return Effect.succeed({
    _tag: "failure",
    error: Cause.squash(exit.cause),
  } satisfies CommandResultOutcome);
};

export const makeNestedExecute =
  (
    runtimeContext: Context.Context<never>,
    streamSink: Context.Tag.Service<typeof StreamFrameSink>,
  ): McpExecute =>
  (entry, runInput) =>
    Effect.gen(function* () {
      const command = entry.spec.run(runInput);
      const rootAwareCommand =
        runInput.appPath === undefined
          ? command
          : command.pipe(Effect.provideService(RuntimeCwd, runInput.appPath));
      const invocation = yield* makeNestedCommandInvocation(entry.spec.id, {
        argv: runInput.argv,
        args: runInput.args,
        flags: runInput.flags,
        ...(runInput.appPath === undefined ? {} : { cwd: runInput.appPath }),
      });
      const exit = yield* runCommandLifecycle(rootAwareCommand, {
        invocation,
        ...(entry.spec.successExitCode === undefined
          ? {}
          : { successExitCode: (value) => entry.spec.successExitCode?.(value, runInput) }),
      });
      return yield* outcomeFromExit(exit);
    }).pipe(
      Effect.provide(runtimeContext),
      Effect.provideService(StreamFrameSink, streamSink),
    ) as Effect.Effect<CommandResultOutcome, never>;
