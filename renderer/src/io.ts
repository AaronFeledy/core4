import type { RendererIO } from "@lando/sdk/renderer";

export type { RendererIO } from "@lando/sdk/renderer";

export const BROKEN_PIPE_EXIT_CODE = 141;

type StdioDestination = "stdout" | "stderr";
interface OutputStream {
  readonly write: (chunk: string) => boolean;
  readonly on?: (event: "error", listener: (error: unknown) => void) => unknown;
}

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
const guardedWrite = (destination: StdioDestination, stream: OutputStream, chunk: string): boolean => {
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

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
  stdin: RendererInputStream = process.stdin,
): RendererIO => ({
  writeStdout: (chunk) => guardedWrite("stdout", stdout, chunk),
  writeStderr: (chunk) => guardedWrite("stderr", stderr, chunk),
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
});

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

export interface BufferedRendererIO extends RendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
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

export const createBufferedRendererIO = (options: BufferedRendererIOOptions = {}): BufferedRendererIO => {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const listeners = new Set<(raw: string) => void>();
  return {
    writeStdout: (chunk) => {
      stdoutBuffer += chunk;
    },
    writeStderr: (chunk) => {
      stderrBuffer += chunk;
    },
    stdout: () => stdoutBuffer,
    stderr: () => stderrBuffer,
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
