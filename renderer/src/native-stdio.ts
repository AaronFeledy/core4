import { writeSync } from "node:fs";
import { outputDrainWaiters } from "./output-streams.ts";

export const BROKEN_PIPE_EXIT_CODE = 141;

type StdioDestination = "stdout" | "stderr";
interface OutputStream {
  readonly isTTY?: boolean;
  readonly fd?: number;
  readonly write: (chunk: string | Uint8Array) => boolean;
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
export const isOutputBroken = (stream: OutputStream): boolean => brokenStreams.has(stream);
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

export const guardedWrite = (
  destination: StdioDestination,
  stream: OutputStream,
  chunk: string | Uint8Array,
): boolean => {
  if (brokenStreams.has(stream)) return false;
  if (!guardedStreams.has(stream)) {
    guardedStreams.add(stream);
    if (typeof stream.on === "function") {
      stream.on("error", (error) => {
        if (!isBrokenPipeError(error)) {
          if ((outputDrainWaiters.get(stream) ?? 0) > 0) return;
          throw error;
        }
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

export const writeStdioLine = (
  destination: StdioDestination,
  text: string,
  stream: OutputStream = process[destination],
): void => {
  guardedWrite(destination, stream, `${text}\n`);
};

export const detachStdioWrites = (): void => {
  const sink: typeof process.stdout.write = (
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof encodingOrCallback === "function") encodingOrCallback(null);
    else if (typeof callback === "function") callback(null);
    return true;
  };
  try {
    process.stdout.write = sink;
    process.stderr.write = sink;
  } catch {
    return;
  }
};
