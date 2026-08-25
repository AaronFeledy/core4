import { closeSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Schema } from "effect";

import type { HostProxyWorkerEntry } from "../../composition.ts";

import { isHostProxyRunLandoEnvName } from "./session-env.ts";

export const HOST_PROXY_WORKER_COMMAND = "__internal:host-proxy-worker";

export const WorkerReady = Schema.TaggedStruct("ready", {
  appId: Schema.String,
  sessionId: Schema.String,
  token: Schema.String,
  controlToken: Schema.String,
  socketPath: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  containerUrl: Schema.optional(Schema.String),
  shimPath: Schema.String,
  transport: Schema.optional(Schema.Literal("unix-socket", "tcp-host-gateway")),
});
export type WorkerReady = typeof WorkerReady.Type;

export interface HostProxyWorkerProcess {
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
  readonly writeStdin: (value: string) => Promise<void>;
  readonly readReady: () => Promise<WorkerReady>;
  readonly terminate: () => Promise<void>;
}

export interface HostProxyWorkerSpawnSpec {
  readonly argv: ReadonlyArray<string>;
  readonly logsDir?: string;
}

export class HostProxyWorkerExitedBeforeReadyError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;
  readonly logPath: string;

  constructor(input: {
    readonly exitCode: number | null;
    readonly stderrTail: string;
    readonly logPath: string;
  }) {
    const exitPart = input.exitCode === null ? "exitCode=unknown" : `exitCode=${input.exitCode}`;
    const stderrPart = input.stderrTail.length === 0 ? "" : ` stderr: ${input.stderrTail}`;
    super(`Detached host-proxy worker exited before readiness. ${exitPart}.${stderrPart}`);
    this.name = "HostProxyWorkerExitedBeforeReadyError";
    this.exitCode = input.exitCode;
    this.stderrTail = input.stderrTail;
    this.logPath = input.logPath;
  }
}

interface DefaultSpawnWorkerOptions {
  readonly payloadTimeoutMs?: number;
}

export type HostProxyWorkerSpawner = (spec: HostProxyWorkerSpawnSpec) => HostProxyWorkerProcess;

const READY_TIMEOUT_MS = 15_000;
const TERMINATE_GRACE_MS = 5_000;
const WORKER_PAYLOAD_CHUNK_BYTES = 64 * 1024;
const WORKER_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;
const WORKER_PAYLOAD_TIMEOUT_MS = 15_000;

const awaitWorkerInput = async (result: number | Promise<number>, deadline: number): Promise<number> => {
  const timeoutMessage = "Host-proxy worker startup payload delivery timed out after 15 seconds.";
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

export const hostProxyWorkerEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !isHostProxyRunLandoEnvName(name)) env[name] = value;
  }
  return env;
};

export const hostProxyWorkerArgv = (
  input: HostProxyWorkerEntry & {
    readonly appId?: string | undefined;
  },
): ReadonlyArray<string> => {
  const ownerArgs = input.appId === undefined ? [] : ["--app-id", input.appId];
  if (input.entryPath?.includes("$bunfs") === true)
    return [input.execPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  if (
    input.entryPath !== undefined &&
    extname(input.entryPath) === ".ts" &&
    input.entryPath.endsWith("bin/lando.ts")
  ) {
    return [input.execPath, input.entryPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  }
  if (basename(input.execPath).startsWith("bun"))
    return [input.execPath, input.bunSourceEntryPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  return [input.execPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
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
      if (remaining <= 0) throw new Error("Detached host-proxy worker readiness timed out.");
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Detached host-proxy worker readiness timed out.")), remaining),
        ),
      ]);
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

const resolveWorkerLogsDir = (logsDir: string | undefined): string =>
  logsDir === undefined || logsDir.length === 0 ? join(tmpdir(), "lando-host-proxy-worker-logs") : logsDir;

const stderrTailFromLog = async (logPath: string): Promise<string> => {
  const file = Bun.file(logPath);
  if ((await file.exists()) !== true) return "";
  const text = await file.text();
  if (text.length === 0) return "";
  const clipped = text.length > STDERR_TAIL_MAX_BYTES ? text.slice(-STDERR_TAIL_MAX_BYTES) : text;
  const lines = clipped.split("\n").filter((line) => line.length > 0);
  return lines.slice(-STDERR_TAIL_MAX_LINES).join("\n");
};

export const defaultSpawnWorker = (
  spec: HostProxyWorkerSpawnSpec,
  options: DefaultSpawnWorkerOptions = {},
): HostProxyWorkerProcess => {
  // File-backed stderr: detached workers outlive the parent, so a pipe SIGPIPEs
  // after start. Keep writing to logsDir for the worker lifetime.
  const logsDir = resolveWorkerLogsDir(spec.logsDir);
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, `host-proxy-worker-${workerLogLabel(spec.argv)}.log`);
  const stderrFd = openSync(logPath, "a");
  const proc = (() => {
    try {
      return Bun.spawn([...spec.argv], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: stderrFd,
        detached: true,
        env: hostProxyWorkerEnv(),
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
        throw new Error("Host-proxy worker startup payload exceeds the 16 MiB limit.");
      const payloadTimeoutMs = options.payloadTimeoutMs ?? WORKER_PAYLOAD_TIMEOUT_MS;
      const deadline = Date.now() + payloadTimeoutMs;
      for (let offset = 0; offset < payload.byteLength; ) {
        const end = Math.min(offset + WORKER_PAYLOAD_CHUNK_BYTES, payload.byteLength);
        await awaitWorkerInput(proc.stdin.write(payload.subarray(offset, end)), deadline);
        offset = end;
        await awaitWorkerInput(proc.stdin.flush(), deadline);
      }
      await awaitWorkerInput(proc.stdin.end(), deadline);
    },
    readReady: async () => {
      const line = await textFromStreamUntilLine(proc.stdout, READY_TIMEOUT_MS);
      if (line.length > 0) return Schema.decodeUnknownSync(WorkerReady)(JSON.parse(line));
      await proc.exited;
      throw new HostProxyWorkerExitedBeforeReadyError({
        exitCode: proc.exitCode,
        stderrTail: await stderrTailFromLog(logPath),
        logPath,
      });
    },
    terminate: async () => {
      proc.kill("SIGTERM");
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), TERMINATE_GRACE_MS)),
      ]);
      if (!exited) proc.kill("SIGKILL");
      await proc.exited;
    },
  };
};
