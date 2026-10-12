import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ProcessRunner, type ShellCommandOptions } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { collectExecStream } from "../operations/exec-stream.ts";
import type { StreamFrameSinkShape } from "../operations/stream-frame-sink.ts";
import * as BunProcessRunner from "./process-runner.ts";
import { quoteShellPath } from "./shell-quote.ts";

export const landoLauncher = (
  target: string,
  platform: NodeJS.Platform,
): { readonly name: string; readonly content: string } =>
  platform === "win32"
    ? {
        name: "lando.cmd",
        content: [
          "@echo off",
          "setlocal DisableDelayedExpansion",
          'set "BUN_BE_BUN="',
          'set "BUN_FEATURE_FLAG_NO_ORPHANS="',
          `"${target.replaceAll("%", "%%")}" %*`,
          "exit /b %errorlevel%",
          "",
        ].join("\r\n"),
      }
    : {
        name: "lando",
        content: `#!/bin/sh\nunset BUN_BE_BUN BUN_FEATURE_FLAG_NO_ORPHANS\nexec ${quoteShellPath(target)} "$@"\n`,
      };

const isPathKey = (key: string): boolean =>
  process.platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";

// Scripts run on Lando's own binary as Bun, and Bun Shell exports BUN_BE_BUN and the
// no-orphans flag to every command with no way to unset them. A nested `lando` would run
// as Bun and reap its own detached workers, so only `lando` goes through a launcher that
// clears both. Other commands keep them: Bun Shell's `bun` fallback needs BUN_BE_BUN.
const scriptEnv = Effect.fnUntraced(function* (options: ShellCommandOptions | undefined) {
  const env: Record<string, string> = { ...options?.env, BUN_BE_BUN: "1" };
  const callerPathKey = Object.keys(env).find(isPathKey);
  const processPathKey = Object.keys(process.env).find(isPathKey) ?? "PATH";
  const effectivePath =
    (callerPathKey === undefined ? process.env[processPathKey] : env[callerPathKey]) ?? "";
  const target =
    Bun.which("lando", { PATH: effectivePath, cwd: options?.cwd ?? process.cwd() }) ??
    (Bun.isStandaloneExecutable ? process.execPath : undefined);
  if (target === undefined) return env;
  const launcher = landoLauncher(target, process.platform);
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "lando-script-bin-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  yield* Effect.tryPromise(() =>
    writeFile(join(directory, launcher.name), launcher.content, { mode: 0o700 }),
  );
  if (callerPathKey !== undefined) delete env[callerPathKey];
  env[processPathKey] = `${directory}${delimiter}${effectivePath}`;
  return env;
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
        env: yield* scriptEnv(options),
      }),
      output.sink === undefined ? Option.none() : Option.some(lineSink),
    );
    for (const kind of ["stdout", "stderr"] as const) {
      if (pending[kind].length > 0) yield* emit(kind, pending[kind]);
    }
    return result;
  },
  Effect.scoped,
  Effect.provide(BunProcessRunner.layer),
);
