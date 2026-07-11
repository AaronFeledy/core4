import { stdout } from "node:process";
import { Effect, Ref, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { AppPlan, type AppRef, type ServicePlan } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "./api.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import { runOpenForHostProxy } from "./dispatch.ts";
import { ensureHostProxyNoProxy } from "./proxy-bypass.ts";
import type { HostProxyShimTarget } from "./transport-shim.ts";
import type { HostProxyTransportKind } from "./transport.ts";
import { createHostProxyRunLandoSession } from "./transport.ts";
import {
  type HostProxyWorkerSpawner,
  defaultSpawnWorker,
  hostProxyWorkerArgv,
  stdinText,
} from "./worker-process.ts";
import {
  removeOwnedHostProxyWorkerState,
  replaceExistingHostProxyWorker,
  withWorkerRecordLock,
  workerStatePath,
  writeWorkerRecord,
} from "./worker-state.ts";

const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
const HOST_PROXY_FEATURE_ID = "lando.host-proxy";

export { HOST_PROXY_WORKER_COMMAND, hostProxyWorkerArgv } from "./worker-process.ts";
export {
  removeOwnedHostProxyWorkerState,
  terminateOwnedHostProxyWorker,
  terminateOwnedHostProxyWorkersInRoot,
  workerStatePath,
} from "./worker-state.ts";

const WorkerInput = Schema.Struct({
  app: Schema.Struct({
    kind: Schema.Literal("user", "scratch"),
    id: Schema.String,
    root: Schema.String,
  }),
  plan: AppPlan,
  paths: Schema.Struct({
    userConfRoot: Schema.optional(Schema.String),
    userCacheRoot: Schema.optional(Schema.String),
    userDataRoot: Schema.optional(Schema.String),
    systemPluginRoot: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
  }),
  shimArtifactPath: Schema.String,
  shimTarget: Schema.optional(
    Schema.Union(
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("x64") }),
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("arm64") }),
    ),
  ),
  hostGatewayName: Schema.optional(Schema.String),
});
type WorkerInput = typeof WorkerInput.Type;

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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const serviceHasHostProxyFeature = (service: ServicePlan): boolean => {
  const extension = service.extensions[SERVICE_FEATURES_EXTENSION_KEY];
  if (!isRecord(extension)) return false;
  const featureIds = extension.featureIds;
  return Array.isArray(featureIds) && featureIds.includes(HOST_PROXY_FEATURE_ID);
};

export const hostProxyEligibleServices = (plan: AppPlan) =>
  Object.values(plan.services).filter(serviceHasHostProxyFeature);

export const hostProxyMountInfoFromPlan = (plan: AppPlan): HostProxyMountInfo => {
  for (const service of hostProxyEligibleServices(plan)) {
    if (service.appMount !== undefined)
      return { containerRoot: String(service.appMount.target), hostRoot: String(service.appMount.source) };
  }
  return { containerRoot: "/app", hostRoot: String(plan.root) };
};

const rootOverridesFromWorkerInput = (paths: WorkerInput["paths"]): RootOverrides => ({
  ...(paths.userConfRoot === undefined ? {} : { userConfRoot: paths.userConfRoot }),
  ...(paths.userCacheRoot === undefined ? {} : { userCacheRoot: paths.userCacheRoot }),
  ...(paths.userDataRoot === undefined ? {} : { userDataRoot: paths.userDataRoot }),
  ...(paths.systemPluginRoot === undefined ? {} : { systemPluginRoot: paths.systemPluginRoot }),
  ...(paths.platform === undefined ? {} : { platform: paths.platform }),
});

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
              let terminatePromise: Promise<void> | undefined;
              let resolveClosed: () => void = () => undefined;
              const closed = new Promise<void>((resolveClosedPromise) => {
                resolveClosed = resolveClosedPromise;
              });
              return writeWorkerRecord(options.app, options.paths, {
                appId: options.app.id,
                pid: worker.pid,
                ...(ready.socketPath === undefined ? {} : { socketPath: ready.socketPath }),
                ...(ready.url === undefined ? {} : { url: ready.url }),
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

export const runHostProxyWorkerProcess = async (): Promise<void> => {
  ensureHostProxyNoProxy("127.0.0.1");
  ensureHostProxyNoProxy("localhost");
  const input = Schema.decodeUnknownSync(WorkerInput)(JSON.parse(await stdinText()));
  const app = { kind: input.app.kind, id: input.app.id, root: input.app.root } as AppRef;
  const runtime = makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }));
  const session = await Effect.runPromise(
    Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<ShellRunner | EventService | RedactionService>();
      return yield* createHostProxyRunLandoSession({
        app,
        mountInfo: hostProxyMountInfoFromPlan(input.plan),
        allowlist: HOST_PROXY_RUNLANDO_ALLOWLIST,
        callerService: "lando",
        executor: (request) => runOpenForHostProxy(input.plan, request).pipe(Effect.provide(runtimeContext)),
        paths: rootOverridesFromWorkerInput(input.paths),
        shimArtifactPath: input.shimArtifactPath,
        ...(input.shimTarget === undefined ? {} : { shimTarget: input.shimTarget }),
        ...(input.hostGatewayName === undefined ? {} : { hostGatewayName: input.hostGatewayName }),
      });
    }).pipe(Effect.provide(runtime)),
  );
  stdout.write(
    `${JSON.stringify({
      _tag: "ready",
      appId: session.appId,
      sessionId: session.sessionId,
      token: session.token,
      controlToken: session.controlToken,
      ...(session.socketPath === undefined ? {} : { socketPath: session.socketPath }),
      ...(session.url === undefined ? {} : { url: session.url }),
      ...(session.containerUrl === undefined ? {} : { containerUrl: session.containerUrl }),
      shimPath: session.shimPath,
      transport: session.transport,
    })}\n`,
  );
  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      void session.close().finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    void session.closed.then(resolveShutdown);
  });
};

export const removeHostProxyWorkerState = (app: AppRef, paths?: RootOverrides): Effect.Effect<void, never> =>
  removeOwnedHostProxyWorkerState(app, paths);
