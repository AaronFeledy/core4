import type { RendererIO } from "@lando/sdk/renderer";

export type { RendererIO } from "@lando/sdk/renderer";

export const BROKEN_PIPE_EXIT_CODE = 141;

type StdioDestination = "stdout" | "stderr";
interface OutputStream {
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

const stdioFactories = new WeakMap<RendererIO, (terminalNewlines: boolean) => RendererIO>();

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
export const withStdioTerminalNewlines = (io: RendererIO, terminalNewlines: boolean): RendererIO =>
  stdioFactories.get(io)?.(terminalNewlines) ?? io;

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
  const io: BinaryRendererIO = {
    writeStdout: (chunk) => guardedWrite("stdout", stdout, stdoutNewlines(chunk)),
    writeStderr: (chunk) => guardedWrite("stderr", stderr, stderrNewlines(chunk)),
    writeStdoutBytes: (chunk) => guardedWrite("stdout", stdout, chunk),
    writeStderrBytes: (chunk) => guardedWrite("stderr", stderr, chunk),
    externalOutputStream: stdout,
    isTTY: stdout.isTTY === true,
    get terminalColumns() {
      return typeof stdout.columns === "number" ? stdout.columns : undefined;
    },
    get terminalRows() {
      return typeof stdout.rows === "number" ? stdout.rows : undefined;
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

export interface BufferedRendererIO extends BinaryRendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutBytes: () => Uint8Array;
  readonly stderrBytes: () => Uint8Array;
  readonly stdoutLines: () => ReadonlyArray<string>;
  readonly stderrLines: () => ReadonlyArray<string>;
  readonly subscribeInput: (onKey: (raw: string) => void) => () => void;
  readonly injectKey: (raw: string) => void;
}

export interface BufferedRendererIOOptions {
  readonly isTTY?: boolean;
  readonly terminalColumns?: number | undefined;
  readonly terminalRows?: number | undefined;
}

const splitLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const createBufferedRendererIO = (options: BufferedRendererIOOptions = {}): BufferedRendererIO => {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const listeners = new Set<(raw: string) => void>();
  return {
    writeStdout: (chunk) => {
      stdoutBuffer += chunk;
      stdoutChunks.push(new TextEncoder().encode(chunk));
    },
    writeStderr: (chunk) => {
      stderrBuffer += chunk;
      stderrChunks.push(new TextEncoder().encode(chunk));
    },
    writeStdoutBytes: (chunk) => {
      stdoutChunks.push(chunk);
      stdoutBuffer += Buffer.from(chunk).toString("latin1");
    },
    writeStderrBytes: (chunk) => {
      stderrChunks.push(chunk);
      stderrBuffer += Buffer.from(chunk).toString("latin1");
    },
    stdout: () => stdoutBuffer,
    stderr: () => stderrBuffer,
    stdoutBytes: () => concatBytes(stdoutChunks),
    stderrBytes: () => concatBytes(stderrChunks),
    stdoutLines: () => splitLines(stdoutBuffer),
    stderrLines: () => splitLines(stderrBuffer),
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
    terminalColumns: options.terminalColumns,
    terminalRows: options.terminalRows,
    subscribeInput: (onKey) => {
      listeners.add(onKey);
      return () => {
        listeners.delete(onKey);
      };
    },
    injectKey: (raw) => {
      for (const listener of [...listeners]) listener(raw);
    },
  };
};
