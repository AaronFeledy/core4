import { basename, extname } from "node:path";
import { Schema } from "effect";
import type { HostProxyWorkerEntry } from "../../composition.ts";
import {
  DetachedWorkerExitedBeforeReadyError,
  type DetachedWorkerProcess,
  type DetachedWorkerSpawnSpec,
  type WorkerExitDetails,
  spawnDetachedWorker,
} from "../detached-worker/process.ts";
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
export type HostProxyWorkerProcess = DetachedWorkerProcess<WorkerReady>;
export type HostProxyWorkerSpawnSpec = DetachedWorkerSpawnSpec;
export type HostProxyWorkerSpawner = (spec: HostProxyWorkerSpawnSpec) => HostProxyWorkerProcess;

export class HostProxyWorkerExitedBeforeReadyError extends DetachedWorkerExitedBeforeReadyError {
  constructor(input: WorkerExitDetails) {
    super(input, "host-proxy");
    this.name = "HostProxyWorkerExitedBeforeReadyError";
  }
}

export const hostProxyWorkerEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !isHostProxyRunLandoEnvName(entry[0]),
    ),
  );

export const hostProxyWorkerArgv = (
  input: HostProxyWorkerEntry & { readonly appId?: string | undefined },
): ReadonlyArray<string> => {
  const ownerArgs = input.appId === undefined ? [] : ["--app-id", input.appId];
  if (input.entryPath?.includes("$bunfs") === true)
    return [input.execPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  if (
    input.entryPath !== undefined &&
    extname(input.entryPath) === ".ts" &&
    input.entryPath.endsWith("bin/lando.ts")
  )
    return [input.execPath, input.entryPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  if (basename(input.execPath).startsWith("bun"))
    return [input.execPath, input.bunSourceEntryPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
  return [input.execPath, HOST_PROXY_WORKER_COMMAND, ...ownerArgs];
};

export const defaultSpawnWorker = (
  spec: HostProxyWorkerSpawnSpec,
  options: { readonly payloadTimeoutMs?: number } = {},
): HostProxyWorkerProcess =>
  spawnDetachedWorker(
    { ...spec, env: hostProxyWorkerEnv() },
    {
      ...options,
      readySchema: WorkerReady,
      logLabel: "host-proxy",
      payloadLabel: "Host-proxy",
      exitedBeforeReady: (details) => new HostProxyWorkerExitedBeforeReadyError(details),
    },
  );
