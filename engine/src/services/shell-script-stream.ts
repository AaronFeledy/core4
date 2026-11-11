import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { ToolingExecError } from "@lando/sdk/errors";
import { ProcessRunner, type ShellCommandOptions, type ShellScriptOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import { StreamFrameSink, type StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import {
  type CapturedHostExecutionContext,
  captureScopedHostExecutionContext,
} from "./host-execution-context.ts";
import * as BunProcessRunner from "./process-runner.ts";
import type { ProcessRedactionCarrier } from "./process-runner.ts";
import { runnerEnvRedaction } from "./runner-redaction.ts";
import { quoteShellPath } from "./shell-quote.ts";

export const streamArgvCommand = Effect.fnUntraced(function* (
  argv: readonly string[],
  options: ShellCommandOptions,
  execution: { readonly tool: string; readonly redaction: ProcessRedactionCarrier },
) {
  const [cmd, ...args] = argv;
  if (cmd === undefined || cmd.length === 0)
    return yield* Effect.fail(
      new ToolingExecError({
        tool: execution.tool,
        message: `Host tooling task ${execution.tool} has an empty executable.`,
        remediation: "Set the first argv element to the host executable to run.",
      }),
    );
  const input = {
    cmd,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const context = yield* captureScopedHostExecutionContext(input);
  const processRunner = yield* Effect.serviceOption(ProcessRunner);
  if (processRunner._tag === "None")
    return yield* Effect.fail(
      new ToolingExecError({
        tool: execution.tool,
        message: "ProcessRunner is unavailable for host argv execution.",
        remediation: "Provide ProcessRunner in the host tooling runtime.",
      }),
    );
  return yield* BunProcessRunner.withProcessRedactionTokens(
    execution.redaction,
    Effect.gen(function* () {
      const redactor = yield* BunProcessRunner.redactorForInput(context);
      const redaction = yield* Effect.serviceOption(RedactionService);
      if (redaction._tag === "Some") {
        const tiers = yield* runnerEnvRedaction(execution.redaction, context);
        yield* redaction.value.registerValues([...execution.redaction.substring, ...tiers.substring]);
        yield* redaction.value.registerValues(tiers.wholeToken, { match: "whole-token" });
      }
      const sink = yield* Effect.serviceOption(StreamFrameSink);
      return yield* BunProcessRunner.withPreparedProcess(
        input,
        (runner, request) =>
          Effect.gen(function* () {
            const event = {
              cmd,
              args,
              ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
              ...(input.env === undefined ? {} : { env: input.env }),
            };
            yield* BunProcessRunner.publishRedactedProcessEvent(context, {
              ...event,
              _tag: "pre-process-exec",
            });
            const result = yield* collectExecStream(runner.streamWithExit(request), sink);
            const output = {
              exitCode: result.exitCode,
              stdout: redactor.redactString(result.stdout ?? ""),
              stderr: redactor.redactString(result.stderr ?? ""),
            };
            yield* BunProcessRunner.publishRedactedProcessEvent(context, {
              ...event,
              ...output,
              _tag: "post-process-exec",
            });
            return output;
          }),
        context,
      ).pipe(
        Effect.provideService(ProcessRunner, processRunner.value),
        mapFailures(
          (cause) =>
            new ToolingExecError({
              tool: execution.tool,
              message: redactor.redactString(`Host tooling task ${execution.tool} failed: ${cause.message}`),
              remediation: redactor.redactString(cause.remediation),
              cause: redactor.redactValue(cause),
            }),
        ),
      );
    }),
  );
}, Effect.scoped);

// Scripts run on Lando's own binary as Bun, and Bun Shell exports BUN_BE_BUN and the
// no-orphans flag to every command with no way to unset them. A nested `lando` would run
// as Bun and reap its own detached workers, so only `lando` goes through a launcher that
// clears both. Other commands keep them: Bun Shell's `bun` fallback needs BUN_BE_BUN.

export const streamBunScript = Effect.fnUntraced(function* (
  path: string,
  options: ShellScriptOptions | undefined,
  output: {
    readonly sink: StreamFrameSinkShape | undefined;
    readonly context: CapturedHostExecutionContext;
    readonly redaction?: ProcessRedactionCarrier;
  },
) {
  const sink = Option.fromUndefinedOr(output.sink);
  const input = {
    cmd: output.context.runtime.execPath,
    args: [...(output.context.platform === "win32" ? [] : ["--no-orphans"]), path, ...(options?.argv ?? [])],
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options?.env, BUN_BE_BUN: "1" },
    ...(options?.hostIo === undefined ? {} : { inheritStdin: true }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.capture === true ? { capture: true } : {}),
  };
  const run = BunProcessRunner.withPreparedProcess(
    input,
    (runner, request) =>
      options?.capture === true
        ? runner.run(request)
        : collectExecStream(runner.streamWithExit(request), sink),
    { ...output.context, env: { ...output.context.env, BUN_BE_BUN: "1" } },
  );
  const result = yield* output.redaction === undefined
    ? run
    : BunProcessRunner.withProcessRedactionTokens(output.redaction, run);
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}, Effect.scoped);

export const streamBunCommand = Effect.fnUntraced(function* (
  command: string,
  options: ShellCommandOptions | undefined,
  execution: {
    readonly sink: Option.Option<StreamFrameSinkShape>;
    readonly context: CapturedHostExecutionContext;
    readonly redaction?: ProcessRedactionCarrier;
  },
) {
  const source = [command, ...(options?.argv ?? []).map(quoteShellPath)].join(" ");
  const input = {
    cmd: execution.context.runtime.execPath,
    args: [...(execution.context.platform === "win32" ? [] : ["--no-orphans"]), "exec", source],
    env: { ...options?.env, BUN_BE_BUN: "1" },
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
    ...(options?.capture === true ? { capture: true } : {}),
  };
  const carrier: ProcessRedactionCarrier = {
    ...execution.redaction,
    substring: [source, ...(execution.redaction?.substring ?? [])],
  };
  const result = yield* BunProcessRunner.withProcessRedactionTokens(
    carrier,
    BunProcessRunner.withPreparedProcess(
      input,
      (runner, request) =>
        options?.capture === true
          ? runner.run(request)
          : collectExecStream(runner.streamWithExit(request), execution.sink),
      { ...execution.context, env: { ...execution.context.env, BUN_BE_BUN: "1" } },
    ),
  );
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}, Effect.scoped);
