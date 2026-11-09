import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RootOverrides } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AgentSocketKind, AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Duration, Effect, Option } from "effect";
import { type WorkerClaim, changeWorkerClaim, withDetachedWorkerLock } from "../detached-worker/claim.ts";
import { terminateWorker } from "../detached-worker/lifecycle.ts";
import {
  isOwnerOnlyRecordFile,
  readDetachedWorkerRecord,
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
) => readDetachedWorkerRecord(recordPath(app, options), AgentRelayWorkerRecord).pipe(mapFailures(stateError));
/** Publishes the record under a claim the caller already holds. */
export const publishAgentRelayWorkerRecord = (
  claim: WorkerClaim,
  options: AgentRelayWorkerStateOptions,
  record: AgentRelayWorkerRecord,
) =>
  writeDetachedWorkerRecord(
    claim,
    {
      schema: AgentRelayWorkerRecord,
      privateFileAccess: options.privateFileAccess,
      directoryMode: AGENT_RELAY_DIRECTORY_MODE,
    },
    record,
  ).pipe(
    mapFailures(stateError),
    Effect.andThen(
      Effect.tryPromise({
        try: () => ensureAgentRelayRunRoot(dirname(claim.path)),
        catch: stateError,
      }),
    ),
  );
export const writeAgentRelayWorkerRecord = (
  app: Pick<AppRef, "id" | "root">,
  options: AgentRelayWorkerStateOptions,
  record: AgentRelayWorkerRecord,
) => withAgentRelayWorkerLock(app, options, (claim) => publishAgentRelayWorkerRecord(claim, options, record));
export const withAgentRelayWorkerLock = <A, E>(
  app: Pick<AppRef, "id" | "root">,
  options: AgentRelayWorkerStateOptions,
  body: (claim: WorkerClaim) => Effect.Effect<A, E>,
) =>
  withDetachedWorkerLock(
    {
      path: recordPath(app, options),
      label: "agent-relay-worker",
      paths: options.paths,
      privateFileAccess: options.privateFileAccess,
    },
    body,
  ).pipe(mapFailures(stateError));

export const agentRelayWorkerProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
};

/** Replaces whatever worker the held claim names; the caller already owns the record lock. */
export const replaceAgentRelayWorkerClaim = Effect.fnUntraced(function* (
  claim: WorkerClaim,
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) {
  const record = yield* readDetachedWorkerRecord(
    recordPath(app, options),
    TerminableAgentRelayWorkerRecord,
  ).pipe(mapFailures(stateError));
  const paths = sshAgentSessionPaths(app, options.paths, options.kind);
  const remove = Effect.tryPromise({
    try: async () => {
      if (record !== undefined) await rm(join(paths.socketDir, record.socketName), { force: true });
      await rm(paths.recordPath, { force: true });
    },
    catch: stateError,
  });
  if (record === undefined)
    return yield* changeWorkerClaim(claim, "reap-stale", remove).pipe(mapFailures(stateError));
  const alive = options.isAlive ?? agentRelayWorkerProcessAlive;
  return yield* terminateWorker({
    claim,
    owned: Effect.gen(function* () {
      yield* registerAgentRelayControlToken(record.controlToken);
      if (record.appId !== app.id || record.appRoot !== app.root || record.kind !== options.kind)
        return yield* Effect.fail(stateError("Worker record belongs to another app."));
      if (!(yield* isOwnerOnlyRecordFile(recordPath(app, options), options.privateFileAccess)))
        return yield* Effect.fail(stateError("Worker record is not private and owned by this user."));
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
        return true;
      }
      return false;
    }),
    shutdown: Effect.gen(function* () {
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
      ).pipe(mapFailures(stateError));
      if (exited.outcome !== "green")
        return yield* Effect.fail(
          stateError("Worker did not exit after termination; its state was retained."),
        );
    }),
    remove,
  }).pipe(mapFailures(stateError));
});

export const replaceExistingAgentRelayWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) => withAgentRelayWorkerLock(app, options, (claim) => replaceAgentRelayWorkerClaim(claim, app, options));

/** Terminates the claimed worker and removes its state directory; the caller holds the lock. */
export const disposeAgentRelayWorker = Effect.fnUntraced(function* (
  claim: WorkerClaim,
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) {
  yield* replaceAgentRelayWorkerClaim(claim, app, options);
  yield* changeWorkerClaim(
    claim,
    "remove",
    Effect.tryPromise({
      try: () => rm(dirname(claim.path), { recursive: true, force: true }),
      catch: stateError,
    }),
  ).pipe(mapFailures(stateError));
});

export const terminateOwnedAgentRelayWorker = (
  app: Pick<AppRef, "id" | "root">,
  options: TerminateAgentRelayWorkerOptions,
) => withAgentRelayWorkerLock(app, options, (claim) => disposeAgentRelayWorker(claim, app, options));
export const removeOwnedAgentRelayWorkerState = terminateOwnedAgentRelayWorker;

export const registerAgentRelayControlToken = Effect.fnUntraced(function* (token: string) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) yield* redaction.value.registerValues([token]);
});
