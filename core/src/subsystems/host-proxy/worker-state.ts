import { mkdir, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";

import { Duration, Effect, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import { AbsolutePath, type AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths, sanitizeAppName } from "../../config/paths.ts";
import { writeFileAtomicScoped } from "../../state-store/atomic.ts";
import { withAdvisoryLock } from "../../state/lock.ts";
import { ensureHostProxyNoProxy } from "./proxy-bypass.ts";
import { hostProxyRunLandoStateDir } from "./transport.ts";

export const HOST_PROXY_WORKER_PROTOCOL_VERSION = 1 as const;
const CONTROL_HEADER = "x-lando-host-proxy-control";
const CONTROL_TIMEOUT_MS = 2_000;
const SHUTDOWN_WAIT_MS = 5_000;
const KILL_GRACE_MS = 5_000;

const HostProxyControlRecord = Schema.Struct({
  appId: Schema.String,
  transport: Schema.Literal("unix-socket", "tcp-host-gateway"),
  socketPath: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  shimPath: Schema.String,
  protocolVersion: Schema.Literal(HOST_PROXY_WORKER_PROTOCOL_VERSION),
  startedAt: Schema.String,
  pid: Schema.Number,
  controlToken: Schema.String,
});
type HostProxyControlRecord = typeof HostProxyControlRecord.Type;

export const HostProxyWorkerRecord = Schema.Struct({
  ...HostProxyControlRecord.fields,
  appRoot: Schema.String,
});
export type HostProxyWorkerRecord = typeof HostProxyWorkerRecord.Type;

const LegacyHostProxyWorkerRecord = HostProxyControlRecord;
type LegacyHostProxyWorkerRecord = typeof LegacyHostProxyWorkerRecord.Type;

const HostProxyWorkerIdentity = Schema.Struct({
  appId: Schema.String,
  sessionId: Schema.String,
  transport: Schema.Literal("unix-socket", "tcp-host-gateway"),
  protocolVersion: Schema.Literal(HOST_PROXY_WORKER_PROTOCOL_VERSION),
  pid: Schema.Number,
});
type HostProxyWorkerIdentity = typeof HostProxyWorkerIdentity.Type;

export interface TerminateHostProxyWorkerOptions {
  readonly paths?: RootOverrides;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}

export type TerminateOwnershipResult = "terminated" | "absent";
export type ProbeWorkerResult = "live" | "dead";

export const workerStatePath = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): string =>
  resolve(hostProxyRunLandoStateDir(app, paths), "worker.json");

const stateError = (message: string, path: string, cause?: unknown): HostProxyTransportUnavailableError =>
  new HostProxyTransportUnavailableError({
    message,
    socketPath: path,
    remediation: "Inspect or remove the host-proxy worker state directory, then retry.",
    ...(cause === undefined ? {} : { cause }),
  });

const readBody = (response: IncomingMessage, timeoutMs: number): Promise<string> =>
  new Promise((resolveBody, reject) => {
    let body = "";
    const timeout = setTimeout(() => {
      response.destroy(new Error("Host-proxy control response timed out."));
    }, timeoutMs);
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.once("error", reject);
    response.once("end", () => {
      clearTimeout(timeout);
      resolveBody(body);
    });
  });

const controlRequest = (
  record: HostProxyControlRecord,
  input: { readonly method: "GET" | "POST"; readonly path: string; readonly timeoutMs: number },
): Promise<{ readonly statusCode: number; readonly body: string }> =>
  new Promise((resolveResponse, reject) => {
    const options = { method: input.method, headers: { [CONTROL_HEADER]: record.controlToken } };
    const onResponse = (response: IncomingMessage): void => {
      void readBody(response, input.timeoutMs).then(
        (body) => resolveResponse({ statusCode: response.statusCode ?? 0, body }),
        reject,
      );
    };
    if (record.url !== undefined) ensureHostProxyNoProxy(new URL(record.url).hostname);
    const req =
      record.url === undefined
        ? httpRequest({ socketPath: record.socketPath, path: input.path, ...options }, onResponse)
        : httpRequest(new URL(input.path, record.url), options, onResponse);
    const timeout = setTimeout(() => {
      req.destroy(new Error("Host-proxy control request timed out."));
    }, input.timeoutMs);
    req.once("error", reject);
    req.once("close", () => clearTimeout(timeout));
    req.end();
  });

export const readWorkerRecord = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(workerStatePath(app, paths));
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(HostProxyWorkerRecord)(await file.json());
    },
    catch: (cause) =>
      stateError("Failed to read host-proxy worker state.", workerStatePath(app, paths), cause),
  });

const readWorkerRecordAt = (path: string): Effect.Effect<HostProxyWorkerRecord | undefined, never> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(HostProxyWorkerRecord)(await file.json());
    } catch {
      return undefined;
    }
  });

const readLegacyWorkerRecordAt = (
  path: string,
): Effect.Effect<LegacyHostProxyWorkerRecord | undefined, never> =>
  Effect.promise(async () => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return Schema.decodeUnknownSync(LegacyHostProxyWorkerRecord)(await file.json());
    } catch {
      return undefined;
    }
  });

export const writeWorkerRecord = (
  app: AppRef,
  paths: RootOverrides | undefined,
  record: HostProxyWorkerRecord,
) => {
  const path = workerStatePath(app, paths);
  return Effect.tryPromise({
    try: () => mkdir(dirname(path), { recursive: true, mode: 0o700 }).then(() => undefined),
    catch: (cause) => stateError("Failed to create host-proxy worker state directory.", path, cause),
  }).pipe(
    Effect.zipRight(
      writeFileAtomicScoped(
        path,
        `${JSON.stringify(Schema.encodeUnknownSync(HostProxyWorkerRecord)(record), null, 2)}\n`,
        {
          mode: 0o600,
        },
      ).pipe(Effect.mapError((cause) => stateError("Failed to write host-proxy worker state.", path, cause))),
    ),
  );
};

const identifyWorker = (record: HostProxyControlRecord) =>
  Effect.tryPromise({
    try: async () => {
      const response = await controlRequest(record, {
        method: "GET",
        path: "/_lando/host-proxy/identify",
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
      if (response.statusCode !== 200) throw new Error(`identify returned ${response.statusCode}`);
      return Schema.decodeUnknownSync(HostProxyWorkerIdentity)(JSON.parse(response.body));
    },
    catch: (cause) => cause,
  });

export const probeWorker = (record: HostProxyControlRecord): Effect.Effect<ProbeWorkerResult> =>
  runProbe(
    {
      id: `host-proxy-worker:${record.appId}`,
      policy: { maxAttempts: 1, timeout: Duration.millis(CONTROL_TIMEOUT_MS) },
      classify: {
        success: (value) => {
          const identity = value as HostProxyWorkerIdentity;
          return identity.appId === record.appId &&
            identity.protocolVersion === record.protocolVersion &&
            identity.pid === record.pid &&
            identity.transport === record.transport
            ? "green"
            : "red";
        },
        failure: () => "red",
      },
    },
    identifyWorker(record),
  ).pipe(
    Effect.map((result) => (result.outcome === "green" ? "live" : "dead")),
    Effect.catchAll(() => Effect.succeed("dead" as const)),
  );

const shutdownWorker = (record: HostProxyControlRecord) =>
  Effect.tryPromise({
    try: async () => {
      await controlRequest(record, {
        method: "POST",
        path: "/_lando/host-proxy/shutdown",
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void));

const defaultTerminateProcess = async (pid: number, signal: NodeJS.Signals): Promise<void> => {
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
};

const awaitWorkerDisconnect = (record: HostProxyControlRecord): Effect.Effect<boolean> =>
  runProbe(
    {
      id: `host-proxy-worker-shutdown:${record.appId}`,
      policy: { maxAttempts: 25, delay: Duration.millis(200), timeout: Duration.millis(SHUTDOWN_WAIT_MS) },
      classify: { success: () => "red", failure: () => "green" },
    },
    identifyWorker(record),
  ).pipe(
    Effect.map((result) => result.outcome === "green"),
    Effect.catchAll(() => Effect.succeed(false)),
  );

const forceTerminateIdentifiedWorker = (
  record: HostProxyControlRecord,
  options: TerminateHostProxyWorkerOptions,
) =>
  Effect.promise(async () => {
    const terminate = options.terminateProcess ?? defaultTerminateProcess;
    await terminate(record.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    await terminate(record.pid, "SIGKILL");
  });

const removeRunDir = (app: Pick<AppRef, "id" | "root">, paths?: RootOverrides): Effect.Effect<void> =>
  Effect.promise(() => rm(dirname(workerStatePath(app, paths)), { recursive: true, force: true }));

const removeRecordDir = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { recursive: true, force: true }));

const terminateControlRecord = (
  record: HostProxyControlRecord,
  options: TerminateHostProxyWorkerOptions,
  removeDir: Effect.Effect<void>,
): Effect.Effect<void> =>
  probeWorker(record).pipe(
    Effect.flatMap((status) =>
      status === "dead"
        ? removeDir
        : shutdownWorker(record).pipe(
            Effect.zipRight(awaitWorkerDisconnect(record)),
            Effect.flatMap((stopped) =>
              stopped ? Effect.void : forceTerminateIdentifiedWorker(record, options),
            ),
            Effect.zipRight(removeDir),
          ),
    ),
  );

export const replaceExistingHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions = {},
) =>
  readWorkerRecord(app, options.paths).pipe(
    Effect.flatMap((record) => {
      if (record === undefined) return removeRunDir(app, options.paths);
      return terminateControlRecord(record, options, removeRunDir(app, options.paths));
    }),
  );

export const withWorkerRecordLock = <A, E>(
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  body: Effect.Effect<A, E>,
) => withAdvisoryLock(workerStatePath(app, paths), "host-proxy-worker", body);

export const terminateOwnedHostProxyWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateHostProxyWorkerOptions = {},
) =>
  withWorkerRecordLock(
    app,
    options.paths,
    readWorkerRecord(app, options.paths).pipe(
      Effect.flatMap((record): Effect.Effect<TerminateOwnershipResult> => {
        if (record === undefined) return removeRunDir(app, options.paths).pipe(Effect.as("absent" as const));
        return replaceExistingHostProxyWorker(app, options).pipe(
          Effect.as("terminated" as const),
          Effect.catchAll(() => Effect.succeed("absent" as const)),
        );
      }),
    ),
  ).pipe(Effect.catchAll(() => Effect.succeed("absent" as const)));

export const removeOwnedHostProxyWorkerState = (
  app: Pick<AppRef, "id" | "root">,
  paths?: RootOverrides,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
): Effect.Effect<void, never> =>
  terminateOwnedHostProxyWorker(app, { ...options, ...(paths === undefined ? {} : { paths }) }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );

export const terminateOwnedHostProxyWorkersInRoot = (
  userDataRoot: string,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const paths = makeLandoPaths({ userDataRoot });
    const entries = yield* Effect.promise(() =>
      readdir(paths.hostProxyRunRoot, { withFileTypes: true }).catch(() => []),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = resolve(paths.hostProxyRunRoot, entry.name, "worker.json");
      const record = yield* readWorkerRecordAt(recordPath);
      if (record === undefined) {
        const legacyRecord = yield* readLegacyWorkerRecordAt(recordPath);
        if (legacyRecord === undefined) continue;
        const legacyDir = resolve(paths.hostProxyRunRoot, sanitizeAppName(legacyRecord.appId));
        if (legacyDir !== resolve(paths.hostProxyRunRoot, entry.name)) continue;
        yield* withAdvisoryLock(
          recordPath,
          "host-proxy-worker",
          terminateControlRecord(legacyRecord, options, removeRecordDir(legacyDir)),
        ).pipe(Effect.catchAll(() => Effect.void));
        continue;
      }
      if (
        resolve(paths.hostProxyRunDir(record.appId, record.appRoot)) !==
        resolve(paths.hostProxyRunRoot, entry.name)
      )
        continue;
      const app = { id: record.appId, root: AbsolutePath.make(record.appRoot) };
      yield* terminateOwnedHostProxyWorker(app, { ...options, paths: { userDataRoot } }).pipe(Effect.asVoid);
    }
  }).pipe(Effect.catchAll(() => Effect.void));
