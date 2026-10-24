import { closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redactor } from "@lando/sdk/secrets";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Schema } from "effect";
import { openWorkerLog, stderrTailFromLog } from "./log.ts";

export interface DetachedWorkerProcess<Ready> {
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
  readonly logPath: string;
  readonly writeStdin: (value: string) => Promise<void>;
  readonly readReady: () => Promise<Ready>;
  readonly terminate: () => Promise<void>;
}

export interface DetachedWorkerSpawnSpec {
  readonly redactor?: Redactor;
  readonly argv: ReadonlyArray<string>;
  readonly logsDir?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly privateFileAccess?: PrivateFileAccess;
}

export class DetachedWorkerExitedBeforeReadyError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly logPath: string;

  constructor(input: WorkerExitDetails, label = "detached") {
    const exitPart = input.exitCode === null ? "exitCode=unknown" : `exitCode=${input.exitCode}`;
    const stderrPart = input.stderrTail.length === 0 ? "" : ` stderr: ${input.stderrTail}`;
    super(
      `Detached ${label} worker exited before readiness. ${exitPart}.${stderrPart} Log: ${input.logPath}`,
    );
    this.name = "DetachedWorkerExitedBeforeReadyError";
    this.exitCode = input.exitCode;
    this.stderrTail = input.stderrTail;
    this.logPath = input.logPath;
  }
}

export class DetachedWorkerStartupError extends Error {
  constructor(
    readonly logPath: string,
    message: string,
  ) {
    super(`${message} Log: ${logPath}`);
    this.name = "DetachedWorkerStartupError";
  }
}

export interface WorkerExitDetails {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly logPath: string;
}

export interface DetachedWorkerOptions<Ready, Encoded> {
  readonly readySchema: Schema.Codec<Ready, Encoded>;
  readonly logLabel: string;
  readonly readyTimeoutMs?: number;
  readonly payloadTimeoutMs?: number;
  readonly payloadLabel?: string;
  readonly exitedBeforeReady?: (details: WorkerExitDetails) => Error;
}

const READY_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 5_000;
const WRITE_FAILURE_EXIT_WAIT_MS = 1_000;
const WORKER_PAYLOAD_CHUNK_BYTES = 64 * 1024;
const WORKER_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;
const WORKER_PAYLOAD_TIMEOUT_MS = 15_000;

const awaitWorkerInput = async (
  result: number | Promise<number>,
  deadline: number,
  label: string,
): Promise<number> => {
  const timeoutMessage = `${label} worker startup payload delivery timed out after 15 seconds.`;
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(timeoutMessage);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(result),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const textFromStreamUntilLine = async (
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = performance.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Detached worker readiness timed out.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Detached worker readiness timed out.")), remaining);
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline);
    }
    return text;
  } finally {
    reader.releaseLock();
  }
};

const workerLogLabel = (argv: ReadonlyArray<string>): string => {
  const appIdIndex = argv.indexOf("--app-id");
  const appId = appIdIndex >= 0 ? argv[appIdIndex + 1] : undefined;
  if (appId !== undefined && appId.length > 0) return appId;
  return String(process.pid);
};

export const spawnDetachedWorker = async <Ready, Encoded>(
  spec: DetachedWorkerSpawnSpec,
  options: DetachedWorkerOptions<Ready, Encoded>,
): Promise<DetachedWorkerProcess<Ready>> => {
  // File-backed stderr: detached workers outlive the parent, so a pipe SIGPIPEs
  // after start. Keep writing to logsDir for the worker lifetime.
  const logsDir = spec.logsDir || join(tmpdir(), `lando-${options.logLabel}-worker-logs`);
  const logPath = join(
    logsDir,
    `${options.logLabel}-worker-${workerLogLabel(spec.argv).replace(/[^\w.-]/g, "_")}.log`,
  );
  const stderrFd = await openWorkerLog(logsDir, logPath, spec.privateFileAccess);
  const proc = (() => {
    try {
      return Bun.spawn([...spec.argv], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: stderrFd,
        detached: true,
        ...(spec.env === undefined ? {} : { env: spec.env }),
      });
    } finally {
      closeSync(stderrFd);
    }
  })();
  proc.unref?.();
  const exitedBeforeReady = async (): Promise<Error> => {
    await proc.exited;
    const details = {
      exitCode: proc.exitCode,
      stderrTail: await stderrTailFromLog(logPath, spec.redactor),
      logPath,
    };
    return (
      options.exitedBeforeReady?.(details) ??
      new DetachedWorkerExitedBeforeReadyError(details, options.logLabel)
    );
  };
  const startupFailure = async (message: string): Promise<Error> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), WRITE_FAILURE_EXIT_WAIT_MS);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    return exited ? exitedBeforeReady() : new DetachedWorkerStartupError(logPath, message);
  };
  return {
    pid: proc.pid,
    argv: spec.argv,
    logPath,
    writeStdin: async (value) => {
      if (proc.exitCode !== null) throw await exitedBeforeReady();
      const payload = new TextEncoder().encode(value);
      if (payload.byteLength > WORKER_PAYLOAD_MAX_BYTES)
        throw new DetachedWorkerStartupError(
          logPath,
          `${options.payloadLabel ?? options.logLabel} worker startup payload exceeds the 16 MiB limit.`,
        );
      const payloadTimeoutMs = options.payloadTimeoutMs ?? WORKER_PAYLOAD_TIMEOUT_MS;
      const deadline = performance.now() + payloadTimeoutMs;
      try {
        for (let offset = 0; offset < payload.byteLength; ) {
          const end = Math.min(offset + WORKER_PAYLOAD_CHUNK_BYTES, payload.byteLength);
          await awaitWorkerInput(
            proc.stdin.write(payload.subarray(offset, end)),
            deadline,
            options.payloadLabel ?? options.logLabel,
          );
          offset = end;
          await awaitWorkerInput(proc.stdin.flush(), deadline, options.payloadLabel ?? options.logLabel);
        }
        await awaitWorkerInput(proc.stdin.end(), deadline, options.payloadLabel ?? options.logLabel);
      } catch {
        throw await startupFailure("Unable to deliver detached worker startup payload.");
      }
      if (proc.exitCode !== null) throw await exitedBeforeReady();
    },
    readReady: async () => {
      let line: string;
      try {
        line = await textFromStreamUntilLine(proc.stdout, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      } catch {
        throw await startupFailure("Detached worker readiness timed out or could not be read.");
      }
      if (line.length === 0) throw await startupFailure("Detached worker stdout closed before readiness.");
      try {
        return Schema.decodeUnknownSync(options.readySchema)(JSON.parse(line));
      } catch {
        // The ready frame contains credentials. Neither parser errors nor the frame may escape.
        throw await startupFailure("Detached worker returned an invalid readiness frame.");
      }
    },
    terminate: async () => {
      proc.kill("SIGTERM");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), TERMINATE_GRACE_MS);
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      if (!exited) proc.kill("SIGKILL");
      await proc.exited;
    },
  };
};
