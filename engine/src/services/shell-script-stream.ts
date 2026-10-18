import { ProcessRunner, type ShellCommandOptions, type ShellScriptOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import type { StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import { createBunCommandEnv } from "./bun-command-env.ts";
import * as BunProcessRunner from "./process-runner.ts";
import { quoteShellPath } from "./shell-quote.ts";

// Scripts run on Lando's own binary as Bun, and Bun Shell exports BUN_BE_BUN and the
// no-orphans flag to every command with no way to unset them. A nested `lando` would run
// as Bun and reap its own detached workers, so only `lando` goes through a launcher that
// clears both. Other commands keep them: Bun Shell's `bun` fallback needs BUN_BE_BUN.
const scriptEnv = Effect.fnUntraced(function* (options: ShellScriptOptions | undefined) {
  const env: Record<string, string> = { ...options?.env, BUN_BE_BUN: "1" };
  const launcher = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      createBunCommandEnv({
        command: "lando",
        env,
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      }),
    ),
    (launcher) => Effect.promise(() => launcher[Symbol.asyncDispose]()),
  );
  return launcher.env;
});

export const streamBunScript = Effect.fnUntraced(
  function* (
    path: string,
    options: ShellScriptOptions | undefined,
    output: {
      readonly sink: StreamFrameSinkShape | undefined;
    },
  ) {
    const runner = yield* ProcessRunner;
    const sink = Option.fromUndefinedOr(output.sink);
    return yield* collectExecStream(
      runner.streamWithExit({
        cmd: process.execPath,
        args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), path, ...(options?.argv ?? [])],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        env: yield* scriptEnv(options),
        ...(options?.hostIo === undefined ? {} : { inheritStdin: true }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
      sink,
    );
  },
  Effect.scoped,
  Effect.provide(BunProcessRunner.layer),
);

export const streamBunCommand = Effect.fnUntraced(
  function* (
    command: string,
    options: ShellCommandOptions | undefined,
    sink: Option.Option<StreamFrameSinkShape>,
  ) {
    const runner = yield* ProcessRunner;
    const source = [command, ...(options?.argv ?? []).map(quoteShellPath)].join(" ");
    return yield* BunProcessRunner.withProcessRedactionTokens(
      [source],
      collectExecStream(
        runner.streamWithExit({
          cmd: process.execPath,
          args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), "exec", source],
          env: yield* scriptEnv(options),
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.stdinStream === undefined ? {} : { stdinStream: options.stdinStream }),
        }),
        sink,
      ),
    );
  },
  Effect.scoped,
  Effect.provide(BunProcessRunner.layer),
);
