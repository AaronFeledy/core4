import type { ShellCommandOptions, ShellScriptOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import type { StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import type { CapturedHostExecutionContext } from "./host-execution-context.ts";
import * as BunProcessRunner from "./process-runner.ts";
import { quoteShellPath } from "./shell-quote.ts";

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
  },
) {
  const runner = BunProcessRunner.serviceWithBunCommandEnv(output.context);
  const sink = Option.fromUndefinedOr(output.sink);
  const input = {
    cmd: process.execPath,
    args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), path, ...(options?.argv ?? [])],
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options?.env, BUN_BE_BUN: "1" },
    ...(options?.hostIo === undefined ? {} : { inheritStdin: true }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.capture === true ? { capture: true } : {}),
  };
  if (options?.capture === true) return yield* runner.run(input);
  return yield* collectExecStream(runner.streamWithExit(input), sink);
}, Effect.scoped);

export const streamBunCommand = Effect.fnUntraced(function* (
  command: string,
  options: ShellCommandOptions | undefined,
  execution: {
    readonly sink: Option.Option<StreamFrameSinkShape>;
    readonly context: CapturedHostExecutionContext;
  },
) {
  const runner = BunProcessRunner.serviceWithBunCommandEnv(execution.context);
  const source = [command, ...(options?.argv ?? []).map(quoteShellPath)].join(" ");
  const input = {
    cmd: process.execPath,
    args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), "exec", source],
    env: { ...options?.env, BUN_BE_BUN: "1" },
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
    ...(options?.capture === true ? { capture: true } : {}),
  };
  return yield* BunProcessRunner.withProcessRedactionTokens(
    [source],
    options?.capture === true
      ? runner.run(input)
      : collectExecStream(runner.streamWithExit(input), execution.sink),
  );
}, Effect.scoped);
