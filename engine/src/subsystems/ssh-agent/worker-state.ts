import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { RootOverrides } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AgentSocketKind, AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Duration, Effect, Option } from "effect";
import {
  isOwnerOnlyRecordFile,
  readDetachedWorkerRecord,
  withDetachedWorkerLock,
  writeDetachedWorkerRecord,
} from "../detached-worker/state-file.ts";
import { AGENT_RELAY_DIRECTORY_MODE, ensureAgentRelayRunRoot, sshAgentSessionPaths } from "./session.ts";
import {
  AgentRelayWorkerRecord,
  type TerminableAgentRelayWorkerIdentity,
  TerminableAgentRelayWorkerRecord,
  identifyAgentRelayWorker,
} from "./worker-protocol.ts";

export interface AgentRelayWorkerStateOptions {
  readonly paths?: RootOverrides;
  readonly kind: AgentSocketKind;
  readonly privateFileAccess: PrivateFileAccess;
}
export interface TerminateAgentRelayWorkerOptions extends AgentRelayWorkerStateOptions {
  readonly identify?: (
    record: TerminableAgentRelayWorkerRecord,
  ) => Promise<TerminableAgentRelayWorkerIdentity>;
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
      directoryMode: AGENT_RELAY_DIRECTORY_MODE,
    },
    record,
  ).pipe(
    Effect.mapError(stateError),
    Effect.andThen(
      Effect.tryPromise({
        try: () => ensureAgentRelayRunRoot(sshAgentSessionPaths(app, options.paths, options.kind).stateDir),
        catch: stateError,
      }),
    ),
  );
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

export const agentRelayWorkerProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
};

export const replaceExistingAgentRelayWorker = Effect.fnUntraced(function* (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) {
  const record = yield* readDetachedWorkerRecord(
    recordPath(app, options),
    TerminableAgentRelayWorkerRecord,
  ).pipe(Effect.mapError(stateError));
  if (record !== undefined) {
    yield* registerAgentRelayControlToken(record.controlToken);
    if (record.appId !== app.id || record.appRoot !== app.root || record.kind !== options.kind)
      return yield* Effect.fail(stateError("Worker record belongs to another app."));
    if (!(yield* isOwnerOnlyRecordFile(recordPath(app, options), options.privateFileAccess)))
      return yield* Effect.fail(stateError("Worker record is not private and owned by this user."));
    const alive = options.isAlive ?? agentRelayWorkerProcessAlive;
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
        identity.protocolVersion !== record.protocolVersion ||
        (record.protocolVersion === 2 && identity.configDigest !== record.configDigest)
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
  const paths = sshAgentSessionPaths(app, options.paths, options.kind);
  yield* Effect.tryPromise({
    try: async () => {
      if (record !== undefined) await rm(join(paths.socketDir, record.socketName), { force: true });
      await rm(paths.recordPath, { force: true });
    },
    catch: stateError,
  });
});

export const disposeAgentRelayWorker = Effect.fnUntraced(function* (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) {
  yield* replaceExistingAgentRelayWorker(app, options);
  yield* Effect.tryPromise({
    try: () =>
      rm(sshAgentSessionPaths(app, options.paths, options.kind).stateDir, { recursive: true, force: true }),
    catch: stateError,
  });
});

export const terminateOwnedAgentRelayWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) => withAgentRelayWorkerLock(app, options, disposeAgentRelayWorker(app, options));
export const removeOwnedAgentRelayWorkerState = terminateOwnedAgentRelayWorker;

export const registerAgentRelayControlToken = Effect.fnUntraced(function* (token: string) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues([token]);
});
