import { Chunk, Effect, Stream } from "effect";

import type { ExecAppOptions } from "@lando/sdk/app";
import type { HostTerminal } from "@lando/sdk/schema";

import { cancellableTerminalStdin } from "./commands/terminal-stdin";

export type ExecAppHostOptions = ExecAppOptions & {
  readonly stdinStream?: AsyncIterable<Uint8Array>;
  readonly terminalResize?: Stream.Stream<{ readonly columns: number; readonly rows: number }>;
  readonly hostTerminal?: HostTerminal;
};

interface RawModeStdin {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  readonly readableFlowing: boolean | null;
  readonly setRawMode?: (enabled: boolean) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
}

interface InheritedStdin extends RawModeStdin, AsyncIterable<Uint8Array> {
  readonly iterator: (options: { readonly destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>;
}

interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly on?: (event: "resize", listener: () => void) => unknown;
  readonly off?: (event: "resize", listener: () => void) => unknown;
}

type HostEnv = Readonly<Record<string, string | undefined>>;

export const attachedHostTerminal = (
  output: TerminalOutput = process.stdout,
  env: HostEnv = process.env,
): HostTerminal | undefined => {
  if (output.isTTY !== true) return undefined;
  const term = env.TERM;
  const colorterm = env.COLORTERM;
  const columns = output.columns;
  const rows = output.rows;
  return {
    ...(term === undefined || term.length === 0 ? {} : { term }),
    ...(colorterm === undefined || colorterm.length === 0 ? {} : { colorterm }),
    ...(typeof columns === "number" && Number.isInteger(columns) && columns > 0 ? { columns } : {}),
    ...(typeof rows === "number" && Number.isInteger(rows) && rows > 0 ? { rows } : {}),
  };
};

const stdoutResizeStream = (
  output: TerminalOutput,
): Stream.Stream<{ readonly columns: number; readonly rows: number }> =>
  Stream.async((emit) => {
    const onResize = (): void => {
      const columns = output.columns;
      const rows = output.rows;
      if (
        typeof columns === "number" &&
        Number.isInteger(columns) &&
        columns > 0 &&
        typeof rows === "number" &&
        Number.isInteger(rows) &&
        rows > 0
      ) {
        emit(Effect.succeed(Chunk.of({ columns, rows })));
      }
    };
    output.on?.("resize", onResize);
    return Effect.sync(() => output.off?.("resize", onResize));
  });

export const withInheritedStdinRawMode = <A, E, R>(
  enabled: boolean,
  effect: Effect.Effect<A, E, R>,
  stdin: RawModeStdin = process.stdin,
): Effect.Effect<A, E, R> => {
  if (!enabled) return effect;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const setRawMode = stdin.setRawMode?.bind(stdin);
      if (setRawMode === undefined || stdin.isTTY !== true) return () => {};
      const wasRaw = stdin.isRaw === true;
      const wasFlowing = stdin.readableFlowing === true;
      setRawMode(true);
      stdin.resume();
      return () => {
        setRawMode(wasRaw);
        if (wasFlowing) stdin.resume();
        else stdin.pause();
      };
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  );
};

export const attachExecHostIo = (
  options: ExecAppOptions,
  stdin: InheritedStdin = process.stdin,
  output: TerminalOutput = process.stdout,
): ExecAppHostOptions => {
  const tty = options.tty === true;
  const hostTerminal = attachedHostTerminal(output);
  const inheritStdin = options.interactive === true || stdin.isTTY !== true;
  const terminalEnvironment = tty
    ? {
        COLUMNS: String(output.columns || 80),
        LINES: String(output.rows || 24),
        ...options.env,
      }
    : undefined;
  return {
    ...options,
    tty,
    ...(terminalEnvironment === undefined ? {} : { env: terminalEnvironment }),
    ...(hostTerminal === undefined ? {} : { hostTerminal }),
    ...(tty && hostTerminal !== undefined ? { terminalResize: stdoutResizeStream(output) } : {}),
    ...(inheritStdin
      ? {
          stdinStream:
            stdin === process.stdin
              ? cancellableTerminalStdin(process.stdin)
              : { [Symbol.asyncIterator]: () => stdin.iterator({ destroyOnReturn: false }) },
        }
      : {}),
  };
};
