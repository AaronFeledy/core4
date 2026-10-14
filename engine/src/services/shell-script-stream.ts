import { ProcessRunner, type ShellCommandOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import type { StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import { createBunCommandEnv } from "./bun-command-env.ts";
import * as BunProcessRunner from "./process-runner.ts";

// Scripts run on Lando's own binary as Bun, and Bun Shell exports BUN_BE_BUN and the
// no-orphans flag to every command with no way to unset them. A nested `lando` would run
// as Bun and reap its own detached workers, so only `lando` goes through a launcher that
// clears both. Other commands keep them: Bun Shell's `bun` fallback needs BUN_BE_BUN.
const scriptEnv = Effect.fnUntraced(function* (options: ShellCommandOptions | undefined) {
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
    options: ShellCommandOptions | undefined,
    output: {
      readonly sink: StreamFrameSinkShape | undefined;
      readonly redact: (text: string) => string;
    },
  ) {
    const pending = { stdout: "", stderr: "" };
    const stdoutDecoder = new TextDecoder("utf-8");
    const stderrDecoder = new TextDecoder("utf-8");
    const emit = (kind: "stdout" | "stderr", chunk: string) =>
      output.sink?.emit({ _tag: kind, chunk: output.redact(chunk), raw: true }) ?? Effect.void;
    const flushPending = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
      pending.stdout += stdoutDecoder.decode();
      pending.stderr += stderrDecoder.decode();
      for (const kind of ["stdout", "stderr"] as const) {
        if (pending[kind].length > 0) yield* emit(kind, pending[kind]);
        pending[kind] = "";
      }
      if (output.sink?.flush !== undefined) yield* output.sink.flush();
    });
    const lineSink: StreamFrameSinkShape = {
      emit: Effect.fnUntraced(function* (frame) {
        const decoder = frame._tag === "stdout" ? stdoutDecoder : stderrDecoder;
        pending[frame._tag] +=
          typeof frame.chunk === "string" ? frame.chunk : decoder.decode(frame.chunk, { stream: true });
        let newline = pending[frame._tag].indexOf("\n");
        while (newline !== -1) {
          const line = pending[frame._tag].slice(0, newline + 1);
          pending[frame._tag] = pending[frame._tag].slice(newline + 1);
          yield* emit(frame._tag, line);
          newline = pending[frame._tag].indexOf("\n");
        }
      }),
      flush: flushPending,
    };
    const runner = yield* ProcessRunner;
    const result = yield* collectExecStream(
      runner.streamWithExit({
        cmd: process.execPath,
        args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), path, ...(options?.argv ?? [])],
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        env: yield* scriptEnv(options),
      }),
      output.sink === undefined ? Option.none() : Option.some(lineSink),
    );
    if (output.sink === undefined) yield* flushPending();
    return result;
  },
  Effect.scoped,
  Effect.provide(BunProcessRunner.layer),
);
