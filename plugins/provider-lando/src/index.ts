/**
 * `@lando/provider-lando` — Lando-managed RuntimeProvider.
 */
import { Effect, Layer, Schema, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppId, type AppPlan, type HostPlatform, PluginManifest } from "@lando/sdk/schema";
import { type AppSelector, RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

import { loadAppliedPlan, persistAppliedPlan, removeAppliedPlan } from "./applied-state.ts";
import { bringDown } from "./bring-down.ts";
import { type BringUpOptions, bringUp } from "./bring-up.ts";
import {
  type PodmanApiClient,
  introspectProviderCapabilities,
  makePodmanApiClient,
  mvpProviderCapabilities,
} from "./capabilities.ts";
import { exec, execStream } from "./exec.ts";
import { inspect } from "./inspect.ts";
import { logs } from "./logs.ts";
import {
  type PodmanCommandRunner,
  type PodmanMachineRunner,
  type RuntimeBundleDownloader,
  setupProviderLando,
} from "./setup.ts";

export {
  appliedPlanPath,
  appliedPlansDir,
  loadAppliedPlan,
  persistAppliedPlan,
  removeAppliedPlan,
} from "./applied-state.ts";
export { composePath, emitCompose, renderCompose } from "./compose.ts";
export type { EmitComposeOptions, EmitComposeResult } from "./compose.ts";
export { bringUp } from "./bring-up.ts";
export type { BringUpOptions } from "./bring-up.ts";
export { bringDown } from "./bring-down.ts";
export type { BringDownOptions } from "./bring-down.ts";
export { exec, execStream } from "./exec.ts";
export type { ExecOptions } from "./exec.ts";
export { inspect } from "./inspect.ts";
export type { InspectOptions } from "./inspect.ts";
export { logs } from "./logs.ts";
export type { LogsOptions } from "./logs.ts";
export {
  MINIMUM_PODMAN_VERSION,
  PodmanMachinePrerequisiteError,
  PodmanNotInstalledError,
  PodmanSocketUnreachableError,
  RuntimeBundleVerificationError,
  ensureMacOSPodmanMachine,
  makeSystemPodmanMachineRunner,
  makeSystemPodmanCommandRunner,
  providerStatePath,
  setupProviderLando,
  stopMacOSPodmanMachine,
  teardownMacOSPodmanMachine,
  upgradeMacOSPodmanMachine,
} from "./setup.ts";
export type {
  PodmanCommandRunner,
  PodmanMachineRunner,
  PodmanMachineStatus,
  RuntimeBundle,
  RuntimeBundleDownloader,
  SetupOptions,
  SetupResult,
} from "./setup.ts";

export {
  decodeProviderCapabilities,
  introspectProviderCapabilities,
  linuxMvpCapabilities,
  macosMvpCapabilities,
  makePodmanApiClient,
  makePodmanInfoRequest,
  mvpProviderCapabilities,
  providerLandoCapabilitiesForPlatform,
} from "./capabilities.ts";
export type {
  PodmanApiClient,
  PodmanApiRequest,
  PodmanHttpRequest,
  PodmanHttpResponse,
} from "./capabilities.ts";

export const PLUGIN_NAME = "@lando/provider-lando" as const;

const makeUnavailable = (operation: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message: `provider-lando does not implement ${operation} yet.`,
  });

const makeNoPlanError = (appId: AppId, operation: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation,
    message: `No applied plan found for app "${appId}". The provider does implement ${operation}, but the app must be started first.`,
    remediation:
      "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
  });

export interface ProviderLayerOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanCommand?: PodmanCommandRunner;
  readonly podmanMachine?: PodmanMachineRunner;
  readonly platform?: HostPlatform;
  readonly runtimeBundleDownloader?: RuntimeBundleDownloader;
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly eventService?: BringUpOptions["eventService"];
}

export const makeRuntimeProvider = (options: ProviderLayerOptions = {}) => {
  const plans = new Map<string, AppPlan>();
  const socketPath = options.socketPath ?? process.env.LANDO_TEST_PODMAN_SOCKET;
  const podmanApi =
    options.podmanApi ?? (socketPath === undefined ? undefined : makePodmanApiClient(socketPath));
  const stateDir = options.stateDir;
  let runtimeVersion: string | undefined;
  const platform =
    options.platform ??
    (process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32");
  const capabilities =
    podmanApi === undefined
      ? Effect.succeed(mvpProviderCapabilities(platform))
      : introspectProviderCapabilities(podmanApi, platform);

  const resolvePlan = (target: AppSelector): Effect.Effect<AppPlan | undefined, never> => {
    if (target.plan !== undefined) return Effect.succeed(target.plan);
    const cached = plans.get(target.app);
    if (cached !== undefined) return Effect.succeed(cached);
    if (stateDir === undefined) return Effect.succeed(undefined);
    return loadAppliedPlan(stateDir, target.app).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(target.app, loaded);
        }),
      ),
    );
  };

  const rememberPlan = (plan: AppPlan): Effect.Effect<void, ProviderUnavailableError> => {
    plans.set(plan.id, plan);
    return stateDir === undefined ? Effect.void : persistAppliedPlan(stateDir, plan).pipe(Effect.asVoid);
  };

  const forgetPlan = (appId: AppId): Effect.Effect<void> => {
    plans.delete(appId);
    return stateDir === undefined ? Effect.void : removeAppliedPlan(stateDir, appId);
  };

  return capabilities.pipe(
    Effect.map(
      (resolvedCapabilities): RuntimeProviderShape => ({
        id: "lando",
        displayName: "Lando Runtime Provider",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: Effect.succeed(true),
        setup: () =>
          setupProviderLando({
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.podmanCommand === undefined ? {} : { podmanCommand: options.podmanCommand }),
            ...(options.podmanMachine === undefined ? {} : { podmanMachine: options.podmanMachine }),
            platform,
            ...(options.runtimeBundleDownloader === undefined
              ? {}
              : { runtimeBundleDownloader: options.runtimeBundleDownloader }),
            ...(stateDir === undefined ? {} : { stateDir }),
            ...(socketPath === undefined ? {} : { socketPath }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                runtimeVersion = result.podmanVersion;
              }),
            ),
            Effect.asVoid,
          ),
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.sync(() => ({
          provider: "0.0.0",
          ...(runtimeVersion === undefined ? {} : { runtime: runtimeVersion }),
        })),
        buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
        pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, {
            ...(podmanApi === undefined ? {} : { podmanApi }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
          }).pipe(Effect.tap(() => rememberPlan(plan))),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        destroy: (target, destroyOptions) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return;
            yield* bringDown(plan, {
              ...(podmanApi === undefined ? {} : { podmanApi }),
              volumes: destroyOptions.volumes,
            });
            if (destroyOptions.removeState !== false) {
              yield* forgetPlan(target.app);
            }
          }),
        exec: (target, command) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "exec"));
            return yield* exec(plan, target, command, {
              ...(podmanApi === undefined ? {} : { podmanApi }),
            });
          }),
        execStream: (target, command) =>
          Stream.unwrap(
            resolvePlan(target).pipe(
              Effect.map((plan) =>
                plan === undefined
                  ? Stream.fail(makeNoPlanError(target.app, "execStream"))
                  : execStream(plan, target, command, {
                      ...(podmanApi === undefined ? {} : { podmanApi }),
                    }),
              ),
            ),
          ),
        run: () => Effect.fail(makeUnavailable("run")),
        logs: (target, logOptions) =>
          Stream.unwrap(
            resolvePlan(target).pipe(
              Effect.map((plan) =>
                plan === undefined
                  ? Stream.fail(makeNoPlanError(target.app, "logs"))
                  : logs(plan, target, logOptions, {
                      ...(podmanApi === undefined ? {} : { podmanApi }),
                    }),
              ),
            ),
          ),
        inspect: (target) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "inspect"));
            return yield* inspect(plan, target, {
              ...(podmanApi === undefined ? {} : { podmanApi }),
            });
          }),
        list: (filter) =>
          Effect.forEach(Array.from(plans.values()), (plan) =>
            Effect.forEach(Object.values(plan.services), (service) =>
              inspect(
                plan,
                { app: plan.id, service: service.name },
                { ...(podmanApi === undefined ? {} : { podmanApi }) },
              ),
            ),
          ).pipe(
            Effect.map((snapshots) => snapshots.flat()),
            Effect.map((snapshots) =>
              filter.app === undefined
                ? snapshots
                : snapshots.filter((snapshot) => snapshot.app === filter.app),
            ),
          ),
      }),
    ),
  );
};

export const makeProviderLayer = (options: ProviderLayerOptions = {}) =>
  Layer.effect(RuntimeProvider, makeRuntimeProvider(options));

export const provider = makeProviderLayer();

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  description: "Reference Lando-managed RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: ["lando"] },
  entry: "./src/index.ts",
});
