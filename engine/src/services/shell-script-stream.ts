import { ProcessRunner, type ShellCommandOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import type { StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import * as BunProcessRunner from "./process-runner.ts";

export const streamBunScript = Effect.fnUntraced(function* (
  path: string,
  options: ShellCommandOptions | undefined,
  output: {
    readonly sink: StreamFrameSinkShape | undefined;
    readonly redact: (text: string) => string;
  },
) {
  const pending = { stdout: "", stderr: "" };
  const emit = (kind: "stdout" | "stderr", chunk: string) =>
    output.sink?.emit({ _tag: kind, chunk: output.redact(chunk), raw: true }) ?? Effect.void;
  const lineSink: StreamFrameSinkShape = {
    emit: Effect.fnUntraced(function* (frame) {
      pending[frame._tag] += frame.chunk;
      let newline = pending[frame._tag].indexOf("\n");
      while (newline !== -1) {
        const line = pending[frame._tag].slice(0, newline + 1);
        pending[frame._tag] = pending[frame._tag].slice(newline + 1);
        yield* emit(frame._tag, line);
        newline = pending[frame._tag].indexOf("\n");
      }
    }),
  };
  const runner = yield* ProcessRunner;
  const result = yield* collectExecStream(
    runner.streamWithExit({
      cmd: process.execPath,
      args: [...(process.platform === "win32" ? [] : ["--no-orphans"]), path, ...(options?.argv ?? [])],
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options?.env, BUN_BE_BUN: "1" },
    }),
    output.sink === undefined ? Option.none() : Option.some(lineSink),
  );
  for (const kind of ["stdout", "stderr"] as const) {
    if (pending[kind].length > 0) yield* emit(kind, pending[kind]);
  }
  return result;
}, Effect.provide(BunProcessRunner.layer));
