import { Effect, Queue, Stream } from "effect";

import type { ExecAppOptions } from "@lando/sdk/app";
import type { HostTerminal } from "@lando/sdk/schema";
import type { ToolingInvocation } from "@lando/sdk/services";

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
  Stream.callback((emit) => {
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
        Queue.offerUnsafe(emit, { columns, rows });
      }
    };
    output.on?.("resize", onResize);
    return Effect.addFinalizer(() => Effect.sync(() => output.off?.("resize", onResize)));
  });

const acquireInheritedStdinRawMode = (stdin: RawModeStdin): (() => void) => {
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
};

export const withInheritedStdinRawMode = <A, E, R>(
  enabled: boolean,
  effect: Effect.Effect<A, E, R>,
  stdin: RawModeStdin = process.stdin,
): Effect.Effect<A, E, R> => {
  if (!enabled) return effect;
  return Effect.acquireUseRelease(
    Effect.sync(() => acquireInheritedStdinRawMode(stdin)),
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

export const attachToolingHostIo = (
  enabled: boolean,
  stdin: InheritedStdin = process.stdin,
  output: TerminalOutput = process.stdout,
): Pick<ToolingInvocation, "tty" | "hostTerminal" | "stdinStream" | "terminalResize"> & {
  readonly restore: () => void;
} => {
  const readers = new Set<() => void>();
  const restore = (): void => {
    for (const release of readers) release();
  };
  const hostTerminal = enabled ? attachedHostTerminal(output) : undefined;
  if (hostTerminal === undefined) return { tty: false, restore };
  if (stdin.isTTY !== true) return { tty: true, hostTerminal, restore };
  const attached = attachExecHostIo({ command: [], tty: true, interactive: true }, stdin, output);
  const input = attached.stdinStream;
  return {
    tty: true,
    hostTerminal,
    restore,
    ...(attached.terminalResize === undefined ? {} : { terminalResize: attached.terminalResize }),
    ...(input === undefined
      ? {}
      : {
          stdinStream: {
            [Symbol.asyncIterator]: () => {
              const restoreRawMode = acquireInheritedStdinRawMode(stdin);
              const release = (): void => {
                if (readers.delete(release)) restoreRawMode();
              };
              readers.add(release);
              let iterator: AsyncIterator<Uint8Array>;
              try {
                iterator = input[Symbol.asyncIterator]();
              } catch (error) {
                release();
                throw error;
              }
              return {
                next: async () => {
                  try {
                    const result = await iterator.next();
                    if (result.done) release();
                    return result;
                  } catch (error) {
                    release();
                    throw error;
                  }
                },
                return: async () => {
                  try {
                    return iterator.return?.() ?? { done: true, value: undefined };
                  } finally {
                    release();
                  }
                },
                throw: async (error: unknown) => {
                  try {
                    if (iterator.throw !== undefined) return iterator.throw(error);
                    const closing = iterator.return?.();
                    release();
                    await closing;
                    throw error;
                  } finally {
                    release();
                  }
                },
              };
            },
          },
        }),
  };
};
