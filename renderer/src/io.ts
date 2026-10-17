import { fstatSync } from "node:fs";
import { type RendererIO, type RendererNarrationIO, narrationIO } from "@lando/sdk/renderer";
import { guardedWrite } from "./native-stdio.ts";

export {
  BROKEN_PIPE_EXIT_CODE,
  detachStdioWrites,
  installBrokenPipeExitPolicy,
  isBrokenPipeError,
  onStdioBrokenPipe,
  writeStdioLine,
} from "./native-stdio.ts";

export type { RendererIO, RendererNarrationIO } from "@lando/sdk/renderer";

const processEvents: NodeJS.EventEmitter = process;

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
const narrationFactories = new WeakMap<
  RendererNarrationIO,
  (terminalNewlines: boolean) => RendererNarrationIO
>();

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
  return stdioFactories.get(io)?.(terminalNewlines) ?? narrationFactories.get(io)?.(terminalNewlines) ?? io;
}

/**
 * A pipe or socket on stdout usually feeds a process that writes to the same
 * terminal. A repainting live region would erase that process's output, so the
 * narration stays append-only line mode.
 */
const stdoutFeedsProcess = (stdout: NodeJS.WriteStream): boolean => {
  // Node types omit `fd` on `tty.WriteStream`; native and pipe stdio streams carry it.
  const fd: unknown = Reflect.get(stdout, "fd");
  if (typeof fd !== "number") return false;
  try {
    const stats = fstatSync(fd);
    return stats.isFIFO() || stats.isSocket();
  } catch {
    return false;
  }
};

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
  stdin: RendererInputStream = process.stdin,
  options: StdioRendererIOOptions = {},
): RendererIO => {
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
  const io: RendererIO = {
    writeStdout: (chunk) =>
      guardedWrite("stdout", stdout, typeof chunk === "string" ? stdoutNewlines(chunk) : chunk),
    writeStderr: (chunk) =>
      guardedWrite("stderr", stderr, typeof chunk === "string" ? stderrNewlines(chunk) : chunk),
    ...(stdoutFeedsProcess(stdout) ? {} : { externalOutputStream: narrationTerminal }),
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
  const translated = (translate: boolean) =>
    createStdioRendererIO(stdout, stderr, stdin, { platform, terminalNewlines: translate });
  stdioFactories.set(io, translated);
  narrationFactories.set(narrationIO(io), (translate) => narrationIO(translated(translate)));
  return io;
};

export {
  type BufferedRendererIO,
  type BufferedRendererIOOptions,
  createBufferedRendererIO,
} from "./buffered-io.ts";
