import { type RootOverrides, makeLandoPaths } from "@lando/paths";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { SshAgentTransportError, causeMessage } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Ref, Schema } from "effect";
import { hostProxyWorkerEntry } from "../../composition.ts";
import { DetachedWorkerLogError } from "../detached-worker/log.ts";
import {
  DetachedWorkerExitedBeforeReadyError,
  type DetachedWorkerProcess,
  type DetachedWorkerSpawnSpec,
  DetachedWorkerStartupError,
  spawnDetachedWorker,
} from "../detached-worker/process.ts";
import { isOwnerOnlyRecordFile } from "../detached-worker/state-file.ts";
import {
  HOST_PROXY_WORKER_COMMAND,
  hostProxyWorkerArgv,
  hostProxyWorkerEnv,
} from "../host-proxy/worker-process.ts";
import { type AgentRelaySession, sshAgentSessionPaths } from "./session.ts";
import {
  AGENT_RELAY_WORKER_COMMAND,
  AGENT_RELAY_WORKER_PROTOCOL_VERSION,
  AgentRelayWorkerInput,
  AgentRelayWorkerReady,
} from "./worker-protocol.ts";
import { reuseAgentRelayWorker } from "./worker-reuse.ts";
import {
  type TerminateAgentRelayWorkerOptions,
  disposeAgentRelayWorker,
  readAgentRelayWorkerRecord,
  registerAgentRelayControlToken,
  replaceExistingAgentRelayWorker,
  withAgentRelayWorkerLock,
  writeAgentRelayWorkerRecord,
} from "./worker-state.ts";

export interface DetachedAgentRelayWorkerOptions extends TerminateAgentRelayWorkerOptions {
  readonly app: AppRef;
  readonly plan: Pick<AppPlan, "id" | "provider">;
  readonly upstream: AgentRelayWorkerInput["upstream"];
  readonly delivery: AgentRelayWorkerInput["delivery"];
  readonly kind: AgentRelayWorkerInput["kind"];
  readonly socketName: string;
  readonly paths?: RootOverrides;
  readonly privateFileAccess: PrivateFileAccess;
  readonly spawnWorker?: (
    spec: DetachedWorkerSpawnSpec,
  ) => DetachedWorkerProcess<AgentRelayWorkerReady> | Promise<DetachedWorkerProcess<AgentRelayWorkerReady>>;
  /** Takes ownership in the same uninterruptible step that keeps the worker. */
  readonly publish?: (session: AgentRelaySession) => Effect.Effect<void>;
}

const workerError = (cause: unknown) =>
  cause instanceof SshAgentTransportError
    ? cause
    : new SshAgentTransportError({
        ...(cause instanceof DetachedWorkerExitedBeforeReadyError ||
        cause instanceof DetachedWorkerStartupError ||
        cause instanceof DetachedWorkerLogError
          ? {
              message: causeMessage(cause),
              remediation: `Inspect ${cause.logPath} for the worker crash.`,
            }
          : {
              message: "Unable to start the SSH agent relay worker.",
              remediation: "Inspect the agent-relay worker log and run lando doctor before retrying.",
            }),
        stage: "worker",
      });

export const startDetachedAgentRelayWorker = (
  options: DetachedAgentRelayWorkerOptions,
): Effect.Effect<AgentRelaySession, SshAgentTransportError> =>
  withAgentRelayWorkerLock(
    options.app,
    options,
    Effect.gen(function* () {
      if (options.app.kind === "global")
        return yield* Effect.fail(workerError("Global apps cannot forward an agent."));
      const entry = hostProxyWorkerEntry();
      const configuration = {
        app: { id: options.app.id, root: options.app.root, kind: options.app.kind },
        plan: { id: options.plan.id, provider: options.plan.provider },
        kind: options.kind,
        socketName: options.socketName,
        upstream: options.upstream,
        delivery: options.delivery,
        paths: { ...makeLandoPaths(options.paths).roots, platform: makeLandoPaths(options.paths).platform },
      };
      const input: AgentRelayWorkerInput = {
        ...configuration,
        configDigest: sha256Hex(canonicalJson({ ...configuration, workerEntry: entry })),
      };
      const reused = yield* reuseAgentRelayWorker(options.app, options, input.configDigest);
      const publish = options.publish ?? (() => Effect.void);
      if (reused !== undefined) return yield* publish(reused).pipe(Effect.as(reused));
      const keep = yield* Ref.make(false);
      yield* replaceExistingAgentRelayWorker(options.app, options);
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            const argv = hostProxyWorkerArgv({ ...entry, appId: options.app.id }).map((arg) =>
              arg === HOST_PROXY_WORKER_COMMAND ? AGENT_RELAY_WORKER_COMMAND : arg,
            );
            const spec = {
              argv,
              logsDir: makeLandoPaths(options.paths).logsDir,
              env: hostProxyWorkerEnv(),
              privateFileAccess: options.privateFileAccess,
            };
            return await (options.spawnWorker?.(spec) ??
              spawnDetachedWorker(spec, { readySchema: AgentRelayWorkerReady, logLabel: "agent-relay" }));
          },
          catch: workerError,
        }),
        (worker) =>
          Effect.gen(function* () {
            const ready = yield* Effect.tryPromise({
              try: async () => {
                await worker.writeStdin(
                  `${JSON.stringify(Schema.encodeSync(AgentRelayWorkerInput)(input))}\n`,
                );
                return await worker.readReady();
              },
              catch: (cause) =>
                workerError(
                  cause instanceof DetachedWorkerExitedBeforeReadyError ||
                    cause instanceof DetachedWorkerStartupError
                    ? cause
                    : new DetachedWorkerStartupError(
                        worker.logPath,
                        "Detached agent-relay worker startup failed.",
                      ),
                ),
            });
            yield* registerAgentRelayControlToken(ready.controlToken);
            if (
              ready.appId !== options.app.id ||
              ready.appRoot !== options.app.root ||
              ready.kind !== options.kind ||
              ready.pid !== worker.pid ||
              ready.socketName !== options.socketName ||
              ready.protocolVersion !== AGENT_RELAY_WORKER_PROTOCOL_VERSION ||
              ready.configDigest !== input.configDigest
            ) {
              return yield* Effect.fail(
                workerError(
                  new DetachedWorkerStartupError(
                    worker.logPath,
                    "Worker readiness does not match the requested app session.",
                  ),
                ),
              );
            }
            let closePromise: Promise<void> | undefined;
            let resolveClosed: () => void = () => undefined;
            const closed = new Promise<void>((resolve) => {
              resolveClosed = resolve;
            });
            const session: AgentRelaySession = {
              appId: ready.appId,
              sessionId: ready.sessionId,
              kind: ready.kind,
              socketName: ready.socketName,
              mount: ready.mount,
              closed,
              close: () => {
                closePromise ??= Effect.runPromise(
                  withAgentRelayWorkerLock(
                    options.app,
                    options,
                    Effect.gen(function* () {
                      const current = yield* readAgentRelayWorkerRecord(options.app, options);
                      if (current?.sessionId !== ready.sessionId || current.pid !== ready.pid) return;
                      if (
                        !(yield* isOwnerOnlyRecordFile(
                          sshAgentSessionPaths(options.app, options.paths, options.kind).recordPath,
                          options.privateFileAccess,
                        ))
                      )
                        return yield* Effect.fail(workerError("Worker record is not private."));
                      yield* Effect.promise(() => worker.terminate());
                      yield* disposeAgentRelayWorker(options.app, options);
                    }),
                  ),
                ).finally(resolveClosed);
                return closePromise;
              },
            };
            yield* Effect.uninterruptible(
              writeAgentRelayWorkerRecord(options.app, options, ready).pipe(
                Effect.andThen(Ref.set(keep, true)),
                Effect.andThen(publish(session)),
              ),
            );
            return session;
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof SshAgentTransportError
                ? cause
                : new SshAgentTransportError({
                    message: createStandaloneRedactor("secrets").redactString(causeMessage(cause)),
                    stage: "worker",
                    remediation: `Inspect ${worker.logPath} for the worker crash.`,
                  }),
            ),
          ),
        (worker) =>
          Ref.get(keep).pipe(
            Effect.flatMap((retained) => (retained ? Effect.void : Effect.promise(() => worker.terminate()))),
          ),
      );
    }),
  ).pipe(Effect.mapError(workerError));
