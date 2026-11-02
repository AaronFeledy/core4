/**
 * MCP retained-runtime command execution seam.
 *
 * `makeNestedExecute` is the `McpExecute` the dispatch loop hands each tool
 * call: it runs a resolved command as a NESTED invocation against the session's
 * single retained runtime (`runtimeContext`) and the per-request stream sink,
 * translating the command lifecycle `Exit` into a `CommandResultOutcome`.
 * Interrupts (cancellation) propagate; this seam must not swallow them.
 */
import { Cause, type Context, Effect, Exit } from "effect";

import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RuntimeCwd } from "@lando/engine/runtime/cwd";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import {
  type CommandResultOutcome,
  type CompletedCommandResult,
  failureOutcomeFromCause,
  normalizeDefect,
} from "@lando/sdk/command-result";
import type { McpExecute } from "./dispatch";
import type { McpCommandExecutorShape } from "./port";

export const outcomeFromExit = (
  exit: Exit.Exit<CompletedCommandResult<unknown>, unknown>,
): Effect.Effect<CommandResultOutcome> => {
  if (exit._tag === "Success") {
    return Effect.succeed(exit.value);
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
  return Effect.succeed(failureOutcomeFromCause(exit.cause, normalizeDefect));
};

export const makeNestedExecute = (
  runtimeContext: Context.Context<unknown>,
  output: {
    readonly sink: Context.Service.Shape<typeof StreamFrameSink>;
    readonly finish: () => Effect.Effect<void>;
  },
  executor: McpCommandExecutorShape,
): McpExecute =>
  Effect.fnUntraced(
    function* (entry, runInput) {
      const bound = yield* Effect.exit(
        entry.spec.bindInput === undefined ? Effect.succeed(runInput) : entry.spec.bindInput(runInput),
      );
      if (bound._tag === "Failure") return yield* outcomeFromExit(Exit.failCause(bound.cause));
      const input = bound.value;
      const runtimeCwd = yield* Effect.serviceOption(RuntimeCwd);
      const cwd = runInput.appPath ?? (runtimeCwd._tag === "Some" ? runtimeCwd.value : process.cwd());
      const completion = entry.spec.completion;
      const command = entry.spec.run(input);
      const rootAwareCommand =
        runInput.appPath === undefined
          ? command
          : command.pipe(Effect.provideService(RuntimeCwd, runInput.appPath));
      const exit = yield* withAppDiscovery(
        cwd,
        executor.execute(
          rootAwareCommand.pipe(Effect.scoped, Effect.ensuring(Effect.suspend(output.finish))),
          {
            commandId: entry.spec.id,
            argv: entry.tooling === true ? [] : (input.parsedArgv ?? input.argv),
            args: entry.tooling === true ? {} : input.args,
            flags: entry.tooling === true ? {} : input.flags,
            ...(runInput.appPath === undefined ? {} : { cwd: runInput.appPath }),
            ...(completion === undefined ? {} : { completion: (value) => completion(value, input) }),
          },
        ),
      );
      return yield* outcomeFromExit(exit);
    },
    Effect.provide(runtimeContext),
    Effect.provideService(StreamFrameSink, output.sink),
  );
