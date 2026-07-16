import { Effect, Ref, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { AppPlan, type AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { HostProxyShimTarget } from "./transport-shim.ts";
import type { HostProxyTransportKind } from "./transport.ts";
import { type HostProxyWorkerSpawner, defaultSpawnWorker, hostProxyWorkerArgv } from "./worker-process.ts";
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
  readonly shimTarget?: HostProxyShimTarget;
  readonly hostGatewayName?: string;
  readonly spawnWorker?: HostProxyWorkerSpawner;
  readonly terminateProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
}

export const startDetachedHostProxyWorker = (options: DetachedHostProxyWorkerOptions) =>
  withWorkerRecordLock(
    options.app,
    options.paths,
    Effect.gen(function* () {
      const keepWorker = yield* Ref.make(false);
      return yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* replaceExistingHostProxyWorker(options.app, {
            ...(options.paths === undefined ? {} : { paths: options.paths }),
            ...(options.terminateProcess === undefined ? {} : { terminateProcess: options.terminateProcess }),
          });
          const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
          return spawnWorker({ argv: hostProxyWorkerArgv({ appId: options.app.id }) });
        }),
        (worker) =>
          Effect.tryPromise({
            try: async () => {
              const encodedPlan = Schema.encodeUnknownSync(AppPlan)(options.plan);
              const landoPaths = makeLandoPaths(options.paths);
              const paths = { ...landoPaths.roots, platform: landoPaths.platform };
              await worker.writeStdin(
                `${JSON.stringify({
                  app: options.app,
                  plan: encodedPlan,
                  paths,
                  shimArtifactPath: options.shimArtifactPath,
                  ...(options.shimTarget === undefined ? {} : { shimTarget: options.shimTarget }),
                  ...(options.hostGatewayName === undefined
                    ? {}
                    : { hostGatewayName: options.hostGatewayName }),
                })}\n`,
              );
              return await worker.readReady();
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.flatMap((ready) => {
              const transport: HostProxyTransportKind =
                ready.transport ??
                (makeLandoPaths(options.paths).platform === "win32" ? "tcp-host-gateway" : "unix-socket");
              const probeService = hostProxyEligibleServices(options.plan)[0]?.name;
              let terminatePromise: Promise<void> | undefined;
              let resolveClosed: () => void = () => undefined;
              const closed = new Promise<void>((resolveClosedPromise) => {
                resolveClosed = resolveClosedPromise;
              });
              return writeWorkerRecord(options.app, options.paths, {
                appId: options.app.id,
                appRoot: options.app.root,
                pid: worker.pid,
                ...(ready.socketPath === undefined ? {} : { socketPath: ready.socketPath }),
                ...(ready.url === undefined ? {} : { url: ready.url }),
                ...(ready.containerUrl === undefined ? {} : { containerUrl: ready.containerUrl }),
                ...(probeService === undefined ? {} : { probeService: String(probeService) }),
                shimPath: ready.shimPath,
                transport,
                protocolVersion: 1,
                startedAt: new Date().toISOString(),
                controlToken: ready.controlToken,
              }).pipe(
                Effect.zipLeft(Ref.set(keepWorker, true)),
                Effect.as({
                  appId: ready.appId,
                  sessionId: ready.sessionId,
                  token: ready.token,
                  controlToken: ready.controlToken,
                  ...(ready.socketPath === undefined ? {} : { socketPath: ready.socketPath }),
                  ...(ready.url === undefined ? {} : { url: ready.url }),
                  ...(ready.containerUrl === undefined ? {} : { containerUrl: ready.containerUrl }),
                  shimPath: ready.shimPath,
                  transport,
                  close: () => {
                    terminatePromise ??= worker.terminate().finally(resolveClosed);
                    return terminatePromise;
                  },
                  closed,
                }),
              );
            }),
          ),
        (worker) =>
          Ref.get(keepWorker).pipe(
            Effect.flatMap((keep) => (keep ? Effect.void : Effect.promise(() => worker.terminate()))),
          ),
      );
    }),
  ).pipe(
    Effect.catchAll((cause) =>
      Effect.fail(
        cause instanceof HostProxyTransportUnavailableError
          ? cause
          : new HostProxyTransportUnavailableError({
              message: cause instanceof Error ? cause.message : String(cause),
              socketPath: workerStatePath(options.app, options.paths),
              remediation: "Inspect the detached host-proxy worker startup failure.",
            }),
      ),
    ),
  );

export const removeHostProxyWorkerState = (app: AppRef, paths?: RootOverrides): Effect.Effect<void, never> =>
  removeOwnedHostProxyWorkerState(app, paths);
