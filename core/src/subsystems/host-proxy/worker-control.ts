import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

import { Duration, Effect, Schema } from "effect";

import { runProbe } from "@lando/sdk/probe";

import { ensureHostProxyNoProxy } from "./proxy-bypass.ts";
import { type HostProxyControlRecord, HostProxyWorkerIdentity } from "./worker-records.ts";

const CONTROL_HEADER = "x-lando-host-proxy-control";
const CONTROL_TIMEOUT_MS = 2_000;
const SHUTDOWN_WAIT_MS = 5_000;
const KILL_GRACE_MS = 5_000;

export type ProbeWorkerResult = "live" | "dead";

export interface WorkerControlTerminationOptions {
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}

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
  options: WorkerControlTerminationOptions,
) =>
  Effect.promise(async () => {
    const terminate = options.terminateProcess ?? defaultTerminateProcess;
    await terminate(record.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
    await terminate(record.pid, "SIGKILL");
  });

export const terminateControlRecord = (
  record: HostProxyControlRecord,
  options: WorkerControlTerminationOptions,
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
