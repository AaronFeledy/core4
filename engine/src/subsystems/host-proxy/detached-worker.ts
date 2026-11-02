import { DateTime, Effect, Ref, Schema } from "effect";

import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { HostProxyTransportUnavailableError, causeMessage } from "@lando/sdk/errors";
import { AppPlan, type AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "@lando/paths";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { hostProxyWorkerEntry } from "../../composition.ts";
import { DetachedWorkerLogError } from "../detached-worker/log.ts";
import {
  DetachedWorkerExitedBeforeReadyError,
  DetachedWorkerStartupError,
} from "../detached-worker/process.ts";
import type { HostProxyShimTarget } from "./transport-shim.ts";
import type { HostProxyRunLandoSession, HostProxyTransportKind } from "./transport.ts";
import {
  type HostProxyWorkerSpawner,
  defaultSpawnWorker,
  hostProxyExecutableIdentity,
  hostProxyWorkerArgv,
} from "./worker-process.ts";
import { HOST_PROXY_WORKER_PROTOCOL_VERSION } from "./worker-records.ts";
import { registerHostProxyCredentials, reuseHostProxyWorker } from "./worker-reuse.ts";
import { hostProxyEligibleServices } from "./worker-service-plan.ts";
import {
  removeOwnedHostProxyWorkerState,
  replaceExistingHostProxyWorker,
  withWorkerRecordLock,
  workerStatePath,
  writeWorkerRecord,
} from "./worker-state.ts";

export interface DetachedHostProxyWorkerOptions {
  readonly app: AppRef;
  readonly plan: AppPlan;
  readonly paths?: RootOverrides;
  readonly shimArtifactPath: string;
  /** Content digest of the helper, so a rebuilt helper at the same path replaces the worker. */
  readonly shimDigest?: string;
  readonly shimTarget?: HostProxyShimTarget;
  readonly hostGatewayName?: string;
  readonly spawnWorker?: HostProxyWorkerSpawner;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly reusePolicy?: "exact" | "adopt";
  /** Takes ownership in the same uninterruptible step that keeps the worker. */
  readonly publish?: (
    session: HostProxyRunLandoSession & { readonly reused?: boolean },
  ) => Effect.Effect<void>;
}

export const startDetachedHostProxyWorker = Effect.fn("HostProxy.startDetachedWorker")(function* (
  options: DetachedHostProxyWorkerOptions,
): Effect.fn.Return<
  HostProxyRunLandoSession & { readonly reused?: boolean },
  HostProxyTransportUnavailableError
> {
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactorOptions = { sourceEnv: { ...process.env } };
  const redactor =
    redaction._tag === "Some"
      ? yield* redaction.value.forProfile("secrets", redactorOptions)
      : createStandaloneRedactor("secrets", redactorOptions);
  return yield* withWorkerRecordLock(
    options.app,
    options.paths,
    Effect.gen(function* () {
      const landoPaths = makeLandoPaths(options.paths);
      const publish = options.publish ?? (() => Effect.void);
      const input = {
        app: { kind: options.app.kind, id: options.app.id, root: options.app.root },
        plan: Schema.encodeUnknownSync(AppPlan)(options.plan),
        paths: { ...landoPaths.roots, platform: landoPaths.platform },
        shimArtifactPath: options.shimArtifactPath,
        ...(options.shimTarget === undefined ? {} : { shimTarget: options.shimTarget }),
        ...(options.hostGatewayName === undefined ? {} : { hostGatewayName: options.hostGatewayName }),
      };
      const { plan: _plan, ...configuration } = input;
      const configDigest = sha256Hex(
        canonicalJson({
          ...configuration,
          ...(options.shimDigest === undefined ? {} : { shimDigest: options.shimDigest }),
          providerId: options.plan.provider,
          workerEntry: hostProxyWorkerEntry(),
          executableIdentity: yield* Effect.tryPromise(() =>
            hostProxyExecutableIdentity(hostProxyWorkerEntry()),
          ),
        }),
      );
      const reused = yield* reuseHostProxyWorker(options, configDigest);
      if (reused !== undefined) return yield* publish(reused).pipe(Effect.as(reused));
      const keepWorker = yield* Ref.make(false);
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* replaceExistingHostProxyWorker(options.app, {
            ...(options.paths === undefined ? {} : { paths: options.paths }),
            ...(options.terminateProcess === undefined ? {} : { terminateProcess: options.terminateProcess }),
            privateFileAccess: options.privateFileAccess,
          });
          const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
          return yield* Effect.tryPromise({
            try: async () =>
              spawnWorker({
                redactor,
                argv: hostProxyWorkerArgv({ ...hostProxyWorkerEntry(), appId: options.app.id }),
                logsDir: makeLandoPaths(options.paths).logsDir,
                privateFileAccess: options.privateFileAccess,
              }),
            catch: (cause) => cause,
          });
        }),
        (worker) =>
          Effect.tryPromise({
            try: async () => {
              await worker.writeStdin(`${JSON.stringify({ ...input, configDigest })}\n`);
              return await worker.readReady();
            },
            catch: (cause) =>
              cause instanceof DetachedWorkerExitedBeforeReadyError ||
              cause instanceof DetachedWorkerStartupError
                ? cause
                : new DetachedWorkerStartupError(
                    worker.logPath,
                    "Detached host-proxy worker startup failed.",
                  ),
          }).pipe(
            Effect.flatMap(
              Effect.fnUntraced(function* (ready) {
                yield* registerHostProxyCredentials(ready);
                const transport: HostProxyTransportKind =
                  ready.transport ??
                  (options.hostGatewayName === undefined ? "unix-socket" : "tcp-host-gateway");
                const probeServices = hostProxyEligibleServices(options.plan).map((service) =>
                  String(service.name),
                );
                let terminatePromise: Promise<void> | undefined;
                let resolveClosed: () => void = () => undefined;
                const closed = new Promise<void>((resolveClosedPromise) => {
                  resolveClosed = resolveClosedPromise;
                });
                const session: HostProxyRunLandoSession & { readonly reused: false } = {
                  appId: ready.appId,
                  sessionId: ready.sessionId,
                  token: ready.token,
                  controlToken: ready.controlToken,
                  ...(ready.socketPath === undefined ? {} : { socketPath: ready.socketPath }),
                  ...(ready.url === undefined ? {} : { url: ready.url }),
                  ...(ready.containerUrl === undefined ? {} : { containerUrl: ready.containerUrl }),
                  shimPath: ready.shimPath,
                  transport,
                  reused: false,
                  close: () => {
                    terminatePromise ??= worker.terminate().finally(resolveClosed);
                    return terminatePromise;
                  },
                  closed,
                };
                return yield* Effect.uninterruptible(
                  writeWorkerRecord(
                    options.app,
                    options.paths,
                    {
                      appId: options.app.id,
                      appRoot: options.app.root,
                      providerId: String(options.plan.provider),
                      pid: worker.pid,
                      ...(ready.socketPath === undefined ? {} : { socketPath: ready.socketPath }),
                      ...(ready.url === undefined ? {} : { url: ready.url }),
                      ...(ready.containerUrl === undefined ? {} : { containerUrl: ready.containerUrl }),
                      ...(probeServices.length === 0 ? {} : { probeServices }),
                      shimPath: ready.shimPath,
                      transport,
                      protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
                      configDigest,
                      sessionId: ready.sessionId,
                      token: ready.token,
                      startedAt: DateTime.formatIso(yield* DateTime.now),
                      controlToken: ready.controlToken,
                    },
                    options.privateFileAccess,
                  ).pipe(
                    Effect.andThen(Ref.set(keepWorker, true)),
                    Effect.andThen(publish(session)),
                    Effect.as(session),
                  ),
                );
              }),
            ),
            Effect.mapError((cause) =>
              cause instanceof HostProxyTransportUnavailableError
                ? cause
                : new HostProxyTransportUnavailableError({
                    message: redactor.redactString(causeMessage(cause)),
                    socketPath: workerStatePath(options.app, options.paths),
                    remediation: `Inspect ${worker.logPath} for the worker crash.`,
                  }),
            ),
          ),
        (worker) =>
          Ref.get(keepWorker).pipe(
            Effect.flatMap((keep) => (keep ? Effect.void : Effect.promise(() => worker.terminate()))),
          ),
      );
    }),
    options.privateFileAccess,
  ).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        cause instanceof HostProxyTransportUnavailableError
          ? cause
          : new HostProxyTransportUnavailableError({
              message: redactor.redactString(causeMessage(cause)),
              socketPath: workerStatePath(options.app, options.paths),
              remediation:
                cause instanceof DetachedWorkerExitedBeforeReadyError ||
                cause instanceof DetachedWorkerStartupError ||
                cause instanceof DetachedWorkerLogError
                  ? `Inspect ${cause.logPath} for the worker crash.`
                  : "Inspect the detached host-proxy worker startup failure.",
            }),
      ),
    ),
  );
});

export const removeHostProxyWorkerState = (
  app: AppRef,
  paths: RootOverrides | undefined,
  privateFileAccess: PrivateFileAccess,
): Effect.Effect<void, never> => removeOwnedHostProxyWorkerState(app, paths, { privateFileAccess });
