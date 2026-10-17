import { writeSync } from "node:fs";
import type { RendererIO, RendererNarrationIO } from "@lando/sdk/renderer";

export type { RendererIO, RendererNarrationIO } from "@lando/sdk/renderer";

export const BROKEN_PIPE_EXIT_CODE = 141;

const processEvents: NodeJS.EventEmitter = process;

type StdioDestination = "stdout" | "stderr";
interface OutputStream {
  readonly isTTY?: boolean;
  readonly fd?: number;
  readonly write: (chunk: string | Uint8Array) => boolean;
  readonly on?: (event: "error", listener: (error: unknown) => void) => unknown;
}

/** Stdio and buffered IO always implement the optional RendererIO byte writers. */
export type BinaryRendererIO = RendererIO & {
  readonly writeStdoutBytes: (chunk: Uint8Array) => void;
  readonly writeStderrBytes: (chunk: Uint8Array) => void;
};

export const isBrokenPipeError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  return (
    ("code" in error && (error.code === "EPIPE" || error.code === "EOF")) ||
    ("message" in error && typeof error.message === "string" && error.message.startsWith("EPIPE"))
  );
};

const brokenStreams = new WeakSet<OutputStream>();
const guardedStreams = new WeakSet<OutputStream>();
const notifiedDestinations = new Set<StdioDestination>();
const brokenPipeListeners = new Set<(destination: StdioDestination) => void>();

export const onStdioBrokenPipe = (listener: (destination: StdioDestination) => void): (() => void) => {
  brokenPipeListeners.add(listener);
  return () => {
    brokenPipeListeners.delete(listener);
  };
};

const exitPolicies = new WeakMap<object, () => void>();

export const installBrokenPipeExitPolicy = (proc?: {
  exitCode?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}): (() => void) => {
  const target = proc ?? process;
  const installed = exitPolicies.get(target);
  if (installed) return installed;
  let active = true;
  let triggered = false;
  const unsubscribe = onStdioBrokenPipe(() => {
    if (triggered) return;
    triggered = true;
    target.exitCode = BROKEN_PIPE_EXIT_CODE;
    target.once("exit", () => {
      if (active) target.exitCode = BROKEN_PIPE_EXIT_CODE;
    });
  });
  const uninstall = () => {
    if (!active) return;
    active = false;
    unsubscribe();
    exitPolicies.delete(target);
  };
  exitPolicies.set(target, uninstall);
  return uninstall;
};

const markBrokenPipe = (destination: StdioDestination, stream: OutputStream): void => {
  brokenStreams.add(stream);
  if (notifiedDestinations.has(destination)) return;
  notifiedDestinations.add(destination);
  for (const listener of brokenPipeListeners) listener(destination);
};

// A closed downstream pipe is normal end-of-consumption, not a command failure.
const guardedWrite = (
  destination: StdioDestination,
  stream: OutputStream,
  chunk: string | Uint8Array,
): boolean => {
  if (brokenStreams.has(stream)) return false;
  if (!guardedStreams.has(stream)) {
    guardedStreams.add(stream);
    if (typeof stream.on === "function") {
      stream.on("error", (error) => {
        if (!isBrokenPipeError(error)) throw error;
        markBrokenPipe(destination, stream);
      });
    }
  }
  try {
    if (
      (stream === process.stdout || stream === process.stderr) &&
      stream.isTTY === true &&
      stream.fd !== undefined
    ) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let offset = 0;
      while (offset < bytes.byteLength)
        offset += writeSync(stream.fd, bytes, offset, bytes.byteLength - offset);
      return true;
    }
    return stream.write(chunk);
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
    markBrokenPipe(destination, stream);
    return false;
  }
};

interface RendererInputStream {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  isPaused(): boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface StdioRendererIOOptions {
  readonly platform?: NodeJS.Platform;
  /** Text-only native TTY translation. Machine writers disable this. */
  readonly terminalNewlines?: boolean;
}

const stdioFactories = new WeakMap<RendererNarrationIO, (terminalNewlines: boolean) => RendererIO>();

const terminalNewlineNormalizer = (enabled: boolean): ((chunk: string) => string) => {
  let previousCarriageReturn = false;
  return (chunk) => {
    if (!enabled || chunk.length === 0) return chunk;
    const normalized = chunk.replace(/\n/g, (_newline, offset: number) =>
      (offset === 0 ? previousCarriageReturn : chunk[offset - 1] === "\r") ? "\n" : "\r\n",
    );
    previousCarriageReturn = chunk.endsWith("\r");
    return normalized;
  };
};

/** Select text translation only for native streams; injected transports own their bytes. */
export function withStdioTerminalNewlines(io: RendererIO, terminalNewlines: boolean): RendererIO;
export function withStdioTerminalNewlines(
  io: RendererNarrationIO,
  terminalNewlines: boolean,
): RendererNarrationIO;
export function withStdioTerminalNewlines(
  io: RendererNarrationIO,
  terminalNewlines: boolean,
): RendererNarrationIO {
  return stdioFactories.get(io)?.(terminalNewlines) ?? io;
}

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
  stdin: RendererInputStream = process.stdin,
  options: StdioRendererIOOptions = {},
): BinaryRendererIO => {
  const platform = options.platform ?? process.platform;
  const terminalNewlines = options.terminalNewlines !== false && platform === "win32";
  const stdoutNewlines = terminalNewlineNormalizer(terminalNewlines && stdout.isTTY === true);
  const stderrNewlines = terminalNewlineNormalizer(terminalNewlines && stderr.isTTY === true);
  const narrationTerminal = new Proxy(stderr, {
    get: (stream, key) => {
      if (key === "on" || key === "off")
        return (event: string, listener: () => void) => {
          if (event === "resize" && stream === process.stderr) {
            if (key === "on") process.on("SIGWINCH", listener);
            else processEvents.off("SIGWINCH", listener);
          } else if (key === "on") stream.on(event, listener);
          else stream.off(event, listener);
          return narrationTerminal;
        };
      if (key === "write")
        return (
          chunk: string | Uint8Array,
          encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
          callback?: (error?: Error | null) => void,
        ): boolean => {
          const written = guardedWrite("stderr", stream, chunk);
          if (typeof encodingOrCallback === "function") encodingOrCallback(null);
          else callback?.(null);
          return written;
        };
      const value = Reflect.get(stream, key, stream);
      return typeof value === "function" ? value.bind(stream) : value;
    },
  });
  const io: BinaryRendererIO = {
    writeStdout: (chunk) => guardedWrite("stdout", stdout, stdoutNewlines(chunk)),
    writeStderr: (chunk) => guardedWrite("stderr", stderr, stderrNewlines(chunk)),
    writeStdoutBytes: (chunk) => guardedWrite("stdout", stdout, chunk),
    writeStderrBytes: (chunk) => guardedWrite("stderr", stderr, chunk),
    externalOutputStream: narrationTerminal,
    isTTY: stderr.isTTY === true,
    stdoutIsTTY: stdout.isTTY === true,
    get stdoutColumns() {
      return typeof stdout.columns === "number" ? stdout.columns : undefined;
    },
    get terminalColumns() {
      return typeof stderr.columns === "number" ? stderr.columns : undefined;
    },
    get terminalRows() {
      return typeof stderr.rows === "number" ? stderr.rows : undefined;
    },
    subscribeInput: (onKey) => {
      if (stdin.isTTY !== true) return () => {};
      const listener = (chunk: Buffer | string): void => onKey(chunk.toString("utf8"));
      const previousRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", listener);
      return () => {
        stdin.off("data", listener);
        stdin.setRawMode(previousRaw);
        stdin.pause();
      };
    },
  };
  stdioFactories.set(io, (translate) =>
    createStdioRendererIO(stdout, stderr, stdin, { platform, terminalNewlines: translate }),
  );
  return io;
};

export const writeStdioLine = (
  destination: "stdout" | "stderr",
  text: string,
  stream: OutputStream = process[destination],
): void => {
  guardedWrite(destination, stream, `${text}\n`);
};

export const detachStdioWrites = (): void => {
  const sink: typeof process.stdout.write = ((
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof encodingOrCallback === "function") encodingOrCallback(null);
    else if (typeof callback === "function") callback(null);
    return true;
  }) as typeof process.stdout.write;
  try {
    process.stdout.write = sink;
    process.stderr.write = sink;
  } catch {
    return;
  }
};

export {
  type BufferedRendererIO,
  type BufferedRendererIOOptions,
  createBufferedRendererIO,
} from "./buffered-io.ts";
