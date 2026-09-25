import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

export interface DetachedWorkerProcess<Ready> {
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
  readonly writeStdin: (value: string) => Promise<void>;
  readonly readReady: () => Promise<Ready>;
  readonly terminate: () => Promise<void>;
}

export interface DetachedWorkerSpawnSpec {
  readonly argv: ReadonlyArray<string>;
  readonly logsDir?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export class DetachedWorkerExitedBeforeReadyError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly logPath: string;

  constructor(input: WorkerExitDetails, label = "detached") {
    const exitPart = input.exitCode === null ? "exitCode=unknown" : `exitCode=${input.exitCode}`;
    const stderrPart = input.stderrTail.length === 0 ? "" : ` stderr: ${input.stderrTail}`;
    super(`Detached ${label} worker exited before readiness. ${exitPart}.${stderrPart}`);
    this.name = "DetachedWorkerExitedBeforeReadyError";
    this.exitCode = input.exitCode;
    this.stderrTail = input.stderrTail;
    this.logPath = input.logPath;
  }
}

export interface WorkerExitDetails {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly logPath: string;
}

export interface DetachedWorkerOptions<Ready, Encoded> {
  readonly readySchema: Schema.Schema<Ready, Encoded>;
  readonly logLabel: string;
  readonly readyTimeoutMs?: number;
  readonly payloadTimeoutMs?: number;
  readonly payloadLabel?: string;
  readonly exitedBeforeReady?: (details: WorkerExitDetails) => Error;
}

const READY_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 5_000;
const WORKER_PAYLOAD_CHUNK_BYTES = 64 * 1024;
const WORKER_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;
const WORKER_PAYLOAD_TIMEOUT_MS = 15_000;

const awaitWorkerInput = async (
  result: number | Promise<number>,
  deadline: number,
  label: string,
): Promise<number> => {
  const timeoutMessage = `${label} worker startup payload delivery timed out after 15 seconds.`;
  const remaining = deadline - Date.now();
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

const STDERR_TAIL_MAX_BYTES = 4 * 1024;
const STDERR_TAIL_MAX_LINES = 8;

const textFromStreamUntilLine = async (
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
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

const stderrTailFromLog = async (logPath: string): Promise<string> => {
  const file = Bun.file(logPath);
  if ((await file.exists()) !== true) return "";
  const text = await file.text();
  if (text.length === 0) return "";
  const clipped = text.length > STDERR_TAIL_MAX_BYTES ? text.slice(-STDERR_TAIL_MAX_BYTES) : text;
  const lines = clipped.split("\n").filter((line) => line.length > 0);
  return lines.slice(-STDERR_TAIL_MAX_LINES).join("\n");
};

export const spawnDetachedWorker = <Ready, Encoded>(
  spec: DetachedWorkerSpawnSpec,
  options: DetachedWorkerOptions<Ready, Encoded>,
): DetachedWorkerProcess<Ready> => {
  // File-backed stderr: detached workers outlive the parent, so a pipe SIGPIPEs
  // after start. Keep writing to logsDir for the worker lifetime.
  const logsDir = spec.logsDir || join(tmpdir(), `lando-${options.logLabel}-worker-logs`);
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(
    logsDir,
    `${options.logLabel}-worker-${workerLogLabel(spec.argv).replace(/[^\w.-]/g, "_")}.log`,
  );
  const stderrFd = openSync(logPath, "a");
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
  return {
    pid: proc.pid,
    argv: spec.argv,
    writeStdin: async (value) => {
      const payload = new TextEncoder().encode(value);
      if (payload.byteLength > WORKER_PAYLOAD_MAX_BYTES)
        throw new Error(
          `${options.payloadLabel ?? options.logLabel} worker startup payload exceeds the 16 MiB limit.`,
        );
      const payloadTimeoutMs = options.payloadTimeoutMs ?? WORKER_PAYLOAD_TIMEOUT_MS;
      const deadline = Date.now() + payloadTimeoutMs;
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
    },
    readReady: async () => {
      const line = await textFromStreamUntilLine(proc.stdout, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
      if (line.length > 0) return Schema.decodeUnknownSync(options.readySchema)(JSON.parse(line));
      await proc.exited;
      const details = {
        exitCode: proc.exitCode,
        stderrTail: await stderrTailFromLog(logPath),
        logPath,
      };
      throw (
        options.exitedBeforeReady?.(details) ??
        new DetachedWorkerExitedBeforeReadyError(details, options.logLabel)
      );
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
