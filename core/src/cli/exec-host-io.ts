import { Chunk, Effect, Stream } from "effect";

import type { ExecAppOptions } from "@lando/sdk/app";

export type ExecAppHostOptions = ExecAppOptions & {
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly terminalResize?: Stream.Stream<{ readonly columns: number; readonly rows: number }>;
};

const stdoutResizeStream = (): Stream.Stream<{ readonly columns: number; readonly rows: number }> =>
  Stream.async((emit) => {
    const stdout = process.stdout;
    const onResize = (): void => {
      const columns = stdout.columns;
      const rows = stdout.rows;
      if (typeof columns === "number" && typeof rows === "number") {
        emit(Effect.succeed(Chunk.of({ columns, rows })));
      }
    };
    stdout.on("resize", onResize);
    return Effect.sync(() => stdout.off("resize", onResize));
  });

export const withInheritedStdinRawMode = <A, E, R>(
  enabled: boolean,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  if (!enabled) return effect;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const stdin = process.stdin;
      if (typeof stdin.setRawMode !== "function" || stdin.isTTY !== true) return () => {};
      const wasRaw = stdin.isRaw === true;
      const wasPaused = stdin.isPaused();
      stdin.setRawMode(true);
      stdin.resume();
      return () => {
        stdin.setRawMode(wasRaw);
        if (wasPaused) stdin.pause();
      };
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  );
};

const ttySizeEnv = (env: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> => ({
  COLUMNS: String(process.stdout.columns || 80),
  LINES: String(process.stdout.rows || 24),
  ...env,
});

export const attachExecHostIo = (options: ExecAppOptions): ExecAppHostOptions => {
  const tty = options.tty === true;
  const interactive = options.interactive === true;
  return {
    ...options,
    ...(tty ? { env: ttySizeEnv(options.env), terminalResize: stdoutResizeStream() } : {}),
    ...(interactive ? { stdinStream: process.stdin } : {}),
  };
};
