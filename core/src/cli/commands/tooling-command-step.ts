import { Effect, Exit, FiberRef } from "effect";

import { ToolingCompileError, ToolingExecError } from "@lando/sdk/errors";
import type { ToolingCommandStep } from "@lando/sdk/schema";

import type { RedactionService } from "../../redaction/service.ts";
import { makeNestedCommandInvocation, runCommandLifecycle } from "../command-lifecycle.ts";
import type { RunToolingOptions, RunToolingResult } from "./tooling.ts";

const toolingCommandStack = FiberRef.unsafeMake<ReadonlyArray<string>>([]);

export const isToolingCommandStep = (step: string | ToolingCommandStep): step is ToolingCommandStep =>
  typeof step !== "string";

export const runToolingCommandSteps = <E, R>(
  steps: ReadonlyArray<ToolingCommandStep>,
  options: RunToolingOptions,
  run: (options: RunToolingOptions) => Effect.Effect<RunToolingResult, E, R>,
): Effect.Effect<RunToolingResult, E | ToolingCompileError, R | RedactionService> =>
  Effect.gen(function* () {
    const stack = yield* FiberRef.get(toolingCommandStack);
    let last: RunToolingResult | undefined;
    for (const step of steps) {
      if (step.flags !== undefined || step.args !== undefined) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: `Structured flags and args are not yet supported for command step ${step.command}.`,
            tool: options.name,
          }),
        );
      }
      if (!step.command.startsWith("app:")) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: `Command step ${step.command} is not an app tooling command.`,
            tool: options.name,
          }),
        );
      }
      if (stack.includes(step.command)) {
        return yield* Effect.fail(
          new ToolingCompileError({
            message: `Tooling command cycle detected at ${step.command}.`,
            tool: options.name,
          }),
        );
      }
      const nested = yield* makeNestedCommandInvocation(step.command, step.raw ?? []);
      const outcome = yield* run({
        name: step.command.slice("app:".length),
        args: step.raw ?? [],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
        ...(step.silent === true
          ? { renderProgress: false }
          : options.renderProgress === undefined
            ? {}
            : { renderProgress: options.renderProgress }),
      }).pipe(Effect.locally(toolingCommandStack, [...stack, step.command]), (effect) =>
        runCommandLifecycle(effect, {
          invocation: nested,
          successExitCode: (result) => result.exitCode,
          failureExitCode: (error) => (error instanceof ToolingExecError ? error.exitCode : undefined),
        }),
      );
      if (Exit.isFailure(outcome)) {
        if (step.ignoreError === true) continue;
        return yield* Effect.failCause(outcome.cause);
      }
      last = outcome.value;
    }
    return (
      last ?? {
        tool: options.name,
        service: ":command",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }
    );
  });
