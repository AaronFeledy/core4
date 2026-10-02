import { type RootOverrides, makeLandoPaths } from "@lando/paths";
import { SshAgentTransportError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { Effect, Ref, Schema } from "effect";
import { hostProxyWorkerEntry } from "../../composition.ts";
import {
  type DetachedWorkerProcess,
  type DetachedWorkerSpawnSpec,
  spawnDetachedWorker,
} from "../detached-worker/process.ts";
import {
  HOST_PROXY_WORKER_COMMAND,
  hostProxyWorkerArgv,
  hostProxyWorkerEnv,
} from "../host-proxy/worker-process.ts";
import type { AgentRelaySession } from "./session.ts";
import {
  AGENT_RELAY_WORKER_COMMAND,
  AgentRelayWorkerInput,
  AgentRelayWorkerReady,
} from "./worker-protocol.ts";
import {
  replaceExistingAgentRelayWorker,
  withAgentRelayWorkerLock,
  writeAgentRelayWorkerRecord,
} from "./worker-state.ts";

export interface DetachedAgentRelayWorkerOptions {
  readonly app: AppRef;
  readonly plan: Pick<AppPlan, "id" | "provider">;
  readonly upstream: AgentRelayWorkerInput["upstream"];
  readonly delivery: AgentRelayWorkerInput["delivery"];
  readonly kind: AgentRelayWorkerInput["kind"];
  readonly socketName: string;
  readonly paths?: RootOverrides;
  readonly privateFileAccess: PrivateFileAccess;
  readonly spawnWorker?: (spec: DetachedWorkerSpawnSpec) => DetachedWorkerProcess<AgentRelayWorkerReady>;
}

const workerError = (cause: unknown) =>
  cause instanceof SshAgentTransportError
    ? cause
    : new SshAgentTransportError({
        message: "Unable to start the SSH agent relay worker.",
        stage: "worker",
        remediation: "Inspect the agent-relay worker log and run lando doctor before retrying.",
        cause,
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
      const input: AgentRelayWorkerInput = {
        app: { ...options.app, kind: options.app.kind },
        plan: options.plan,
        kind: options.kind,
        socketName: options.socketName,
        upstream: options.upstream,
        delivery: options.delivery,
        paths: { ...makeLandoPaths(options.paths).roots, platform: makeLandoPaths(options.paths).platform },
      };
      const keep = yield* Ref.make(false);
      yield* replaceExistingAgentRelayWorker(options.app, options);
      return yield* Effect.acquireUseRelease(
        Effect.try({
          try: () => {
            const argv = hostProxyWorkerArgv({ ...hostProxyWorkerEntry(), appId: options.app.id }).map(
              (arg) => (arg === HOST_PROXY_WORKER_COMMAND ? AGENT_RELAY_WORKER_COMMAND : arg),
            );
            const spec = { argv, logsDir: makeLandoPaths(options.paths).logsDir, env: hostProxyWorkerEnv() };
            return (
              options.spawnWorker?.(spec) ??
              spawnDetachedWorker(spec, { readySchema: AgentRelayWorkerReady, logLabel: "agent-relay" })
            );
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
              catch: workerError,
            });
            if (
              ready.appId !== options.app.id ||
              ready.appRoot !== options.app.root ||
              ready.kind !== options.kind ||
              ready.pid !== worker.pid ||
              ready.socketName !== options.socketName ||
              ready.protocolVersion !== 1
            ) {
              return yield* Effect.fail(
                workerError("Worker readiness does not match the requested app session."),
              );
            }
            yield* writeAgentRelayWorkerRecord(options.app, options, ready);
            let closePromise: Promise<void> | undefined;
            let resolveClosed: () => void = () => undefined;
            const closed = new Promise<void>((resolve) => {
              resolveClosed = resolve;
            });
            yield* Ref.set(keep, true);
            return {
              appId: ready.appId,
              sessionId: ready.sessionId,
              kind: ready.kind,
              socketName: ready.socketName,
              mount: ready.mount,
              closed,
              close: () => {
                closePromise ??= worker.terminate().finally(resolveClosed);
                return closePromise;
              },
            };
          }),
        (worker) =>
          Ref.get(keep).pipe(
            Effect.flatMap((retained) => (retained ? Effect.void : Effect.promise(() => worker.terminate()))),
          ),
      );
    }),
  ).pipe(Effect.mapError(workerError));
