import { rm } from "node:fs/promises";
import type { RootOverrides } from "@lando/paths";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AgentSocketKind, AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Duration, Effect } from "effect";
import {
  readDetachedWorkerRecord,
  withDetachedWorkerLock,
  writeDetachedWorkerRecord,
} from "../detached-worker/state-file.ts";
import { sshAgentSessionPaths } from "./session.ts";
import {
  type AgentRelayWorkerIdentity,
  AgentRelayWorkerRecord,
  identifyAgentRelayWorker,
} from "./worker-protocol.ts";

export interface AgentRelayWorkerStateOptions {
  readonly paths?: RootOverrides;
  readonly kind: AgentSocketKind;
  readonly privateFileAccess: PrivateFileAccess;
}
export interface TerminateAgentRelayWorkerOptions extends AgentRelayWorkerStateOptions {
  readonly identify?: (record: AgentRelayWorkerRecord) => Promise<AgentRelayWorkerIdentity>;
  readonly isAlive?: (pid: number) => boolean;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}
const stateError = (cause: unknown) =>
  cause instanceof SshAgentTransportError
    ? cause
    : new SshAgentTransportError({
        message: "Unable to safely manage the agent relay worker.",
        stage: "worker",
        remediation: "Inspect the app's relay worker state and stop its owning session before retrying.",
        cause,
      });
const recordPath = (app: Pick<AppRef, "id" | "root">, options: AgentRelayWorkerStateOptions) =>
  sshAgentSessionPaths(app, options.paths, options.kind).recordPath;

export const readAgentRelayWorkerRecord = (
  app: Pick<AppRef, "id" | "root">,
  options: AgentRelayWorkerStateOptions,
) =>
  readDetachedWorkerRecord(recordPath(app, options), AgentRelayWorkerRecord).pipe(
    Effect.mapError(stateError),
  );
export const writeAgentRelayWorkerRecord = (
  app: Pick<AppRef, "id" | "root">,
  options: AgentRelayWorkerStateOptions,
  record: AgentRelayWorkerRecord,
) =>
  writeDetachedWorkerRecord(
    {
      path: recordPath(app, options),
      schema: AgentRelayWorkerRecord,
      privateFileAccess: options.privateFileAccess,
      directoryMode: 0o711,
    },
    record,
  ).pipe(Effect.mapError(stateError));
export const withAgentRelayWorkerLock = <A, E>(
  app: Pick<AppRef, "id" | "root">,
  options: AgentRelayWorkerStateOptions,
  body: Effect.Effect<A, E>,
) =>
  withDetachedWorkerLock(
    {
      path: recordPath(app, options),
      label: "agent-relay-worker",
      privateFileAccess: options.privateFileAccess,
    },
    body,
  ).pipe(Effect.mapError(stateError));

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
};

export const replaceExistingAgentRelayWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) =>
  Effect.gen(function* () {
    const record = yield* readAgentRelayWorkerRecord(app, options);
    if (record !== undefined) {
      if (record.appId !== app.id || record.appRoot !== app.root || record.kind !== options.kind)
        return yield* Effect.fail(stateError("Worker record belongs to another app."));
      yield* Effect.tryPromise({
        try: () => options.privateFileAccess.verify(recordPath(app, options)),
        catch: stateError,
      });
      const alive = options.isAlive ?? processAlive;
      if (yield* Effect.try({ try: () => alive(record.pid), catch: stateError })) {
        const identity = yield* Effect.tryPromise({
          try: () => (options.identify ?? identifyAgentRelayWorker)(record),
          catch: stateError,
        });
        if (
          identity.pid !== record.pid ||
          identity.sessionId !== record.sessionId ||
          identity.appId !== app.id ||
          identity.appRoot !== app.root ||
          identity.kind !== options.kind ||
          identity.protocolVersion !== 1
        )
          return yield* Effect.fail(stateError("Live worker identity differs from its record."));
        const terminate =
          options.terminateProcess ??
          (async (pid: number, signal: NodeJS.Signals) => {
            process.kill(pid, signal);
          });
        yield* Effect.tryPromise({ try: () => terminate(record.pid, "SIGTERM"), catch: stateError });
        const exited = yield* runProbe(
          {
            id: "agent-relay-worker-exit",
            policy: { maxAttempts: 25, delay: Duration.millis(200), timeout: Duration.millis(5_000) },
            classify: { success: (value) => (value === false ? "green" : "red"), failure: () => "red" },
          },
          Effect.try({ try: () => alive(record.pid), catch: stateError }),
        ).pipe(Effect.mapError(stateError));
        if (exited.outcome !== "green")
          return yield* Effect.fail(
            stateError("Worker did not exit after termination; its state was retained."),
          );
      }
    }
    yield* Effect.tryPromise({
      try: () =>
        rm(sshAgentSessionPaths(app, options.paths, options.kind).stateDir, { recursive: true, force: true }),
      catch: stateError,
    });
  });

export const terminateOwnedAgentRelayWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) => withAgentRelayWorkerLock(app, options, replaceExistingAgentRelayWorker(app, options));
export const removeOwnedAgentRelayWorkerState = terminateOwnedAgentRelayWorker;
