import { fstatSync, writeSync } from "node:fs";
import { outputDrainWaiters } from "./output-streams.ts";

export const BROKEN_PIPE_EXIT_CODE = 141;

interface StdioSnapshot {
  readonly fd: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly flags: number;
}
let stdioFlagsInstalled = false;
let reconcileStdioFlags: (() => void) | undefined;

export const restoreStdioFileStatusFlags = (): void => {
  reconcileStdioFlags?.();
};

export const preserveStdioFileStatusFlags = (): void => {
  if (stdioFlagsInstalled) return;
  stdioFlagsInstalled = true;
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  try {
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
    // Keep libc open: the exit listener still needs its symbols.
    const libc = dlopen(process.platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
      fcntl: {
        args: ["i32", "i32", "i64", "i64", "i64", "i64", "i64", "i64", "i64"],
        returns: "i32",
      },
    });
    // SysV x86-64 / Linux AAPCS64 use arg 3 for variadic ints; Apple arm64
    // uses the stack, whose first slot is arg 9 after x0–x7. Fill both locations.
    const fcntl = (fd: number, cmd: number, value = 0n): number =>
      libc.symbols.fcntl(fd, cmd, value, value, value, value, value, value, value);
    const F_GETFL = 3;
    const F_SETFL = 4;
    const nonblock = process.platform === "linux" ? 0o4000 : 0x4;
    const snapshots: StdioSnapshot[] = [];
    for (const fd of [0, 1, 2]) {
      try {
        const { dev, ino } = fstatSync(fd, { bigint: true });
        const flags = fcntl(fd, F_GETFL);
        if (flags >= 0) snapshots.push({ fd, dev, ino, flags });
      } catch {
        // Closed or unavailable inherited descriptors need no restoration.
      }
    }
    reconcileStdioFlags = () => {
      for (const snapshot of snapshots) {
        try {
          const { dev, ino } = fstatSync(snapshot.fd, { bigint: true });
          if (dev !== snapshot.dev || ino !== snapshot.ino) continue;
          const current = fcntl(snapshot.fd, F_GETFL);
          if (current >= 0 && (current & nonblock) !== (snapshot.flags & nonblock)) {
            fcntl(snapshot.fd, F_SETFL, BigInt((current & ~nonblock) | (snapshot.flags & nonblock)));
          }
        } catch {
          // Exit cleanup is best-effort when a descriptor has been closed or replaced.
        }
      }
    };
    process.once("exit", restoreStdioFileStatusFlags);
  } catch {
    // Native flag restoration is best-effort on hosts without these libc symbols (e.g. musl).
  }
};

type StdioDestination = "stdout" | "stderr";
interface OutputStream {
  readonly isTTY?: boolean;
  readonly fd?: number;
  readonly write: (chunk: string | Uint8Array) => boolean;
  readonly on?: (event: "error" | "drain", listener: (error: unknown) => void) => unknown;
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
const blockedStreams = new WeakSet<OutputStream>();
export const isOutputBlocked = (stream: OutputStream): boolean => blockedStreams.has(stream);
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
      stream.on("drain", () => blockedStreams.delete(stream));
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
    blockedStreams.add(stream);
    const accepted = stream.write(chunk);
    if (accepted) blockedStreams.delete(stream);
    return accepted;
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
