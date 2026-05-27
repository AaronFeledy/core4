/**
 * `@lando/provider-podman` — opt-in RuntimeProvider for a user-installed
 * Podman socket.
 *
 * Unlike `@lando/provider-lando`, this plugin does NOT manage a private Podman
 * machine. It targets an existing user-installed rootless Podman (Linux) or a
 * Podman Desktop machine (macOS / Windows — refined further in US-079).
 *
 * Wire format reuses the Podman REST API client and lifecycle ops from
 * `@lando/provider-lando` (apply / inspect / exec / logs / destroy speak the
 * same Podman API). The error `providerId` for lifecycle failures still
 * reads `"lando"` because those errors are constructed deep inside the
 * shared helpers; rewriting them would require duplicating the full
 * lifecycle. Provider-podman therefore overrides only the surface fields
 * (id, displayName, capabilities, inspect snapshot providerId) and the
 * fail-closed conflict-detection path.
 */
import { readFile } from "node:fs/promises";

import { Effect, Layer, Schema, Stream } from "effect";

import {
  type BringUpOptions,
  type PodmanApiClient,
  bringDown,
  bringUp,
  exec,
  execStream,
  inspect,
  introspectProviderCapabilities,
  logs,
  makePodmanApiClient,
  providerStatePath as providerLandoStatePath,
} from "@lando/provider-lando";
import { ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppId,
  type AppPlan,
  type HostPlatform,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
} from "@lando/sdk/schema";
import { type AppSelector, RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

export const PLUGIN_NAME = "@lando/provider-podman" as const;

const PROVIDER_ID = "podman";
const providerIdBranded = ProviderId.make(PROVIDER_ID);

/**
 * Tagged subclass of `ProviderUnavailableError` raised when this provider
 * would talk to the same Podman socket already owned by `@lando/provider-lando`'s
 * recorded setup. The user must choose one provider explicitly to resolve the
 * ambiguity.
 */
export class ProviderLandoConflictError extends ProviderUnavailableError {
  constructor(args: {
    readonly socketPath: string;
    readonly providerLandoStatePath: string;
    readonly cause?: unknown;
  }) {
    super({
      providerId: PROVIDER_ID,
      operation: "select",
      message: `provider-podman would use the Podman socket "${args.socketPath}", which is already managed by @lando/provider-lando (setup recorded at ${args.providerLandoStatePath}).`,
      remediation:
        "Choose one provider explicitly. Run `lando setup --provider=podman` to switch to the user-installed Podman, or `lando setup --provider=lando` to keep the Lando-managed runtime. Alternatively, set `provider:` in your Landofile.",
      details: {
        socketPath: args.socketPath,
        providerLandoStatePath: args.providerLandoStatePath,
      },
      ...(args.cause === undefined ? {} : { cause: args.cause }),
    });
  }
}

export interface ResolvePodmanSocketOptions {
  readonly socketPath?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const platformFromProcess = (): HostPlatform =>
  process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "win32";

const stripUnixPrefix = (value: string): string =>
  value.startsWith("unix://") ? value.slice("unix://".length) : value;

const defaultPodmanSocket = (
  platform: HostPlatform,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  if (platform === "linux") {
    const xdgRuntimeDir = env.XDG_RUNTIME_DIR;
    if (xdgRuntimeDir !== undefined && xdgRuntimeDir.length > 0) {
      return `${xdgRuntimeDir.replace(/\/+$/u, "")}/podman/podman.sock`;
    }
    return "/run/podman/podman.sock";
  }
  if (platform === "darwin") {
    const home = env.HOME;
    if (home !== undefined && home.length > 0) {
      return `${home.replace(/\/+$/u, "")}/.local/share/containers/podman/machine/podman-machine-default/podman.sock`;
    }
    return "/var/run/podman/podman.sock";
  }
  // Windows / Podman Desktop default; refined further in US-079.
  return "npipe://./pipe/podman-machine-default";
};

/**
 * Resolve the Podman socket path following the discovery precedence:
 *
 * 1. Explicit `socketPath` option.
 * 2. `LANDO_TEST_PODMAN_SOCKET` env (test seam).
 * 3. `DOCKER_HOST` env override (Podman's libpod is Docker-Engine-API-compatible).
 * 4. Platform default (`$XDG_RUNTIME_DIR/podman/podman.sock` on Linux).
 */
export const resolvePodmanSocket = (options: ResolvePodmanSocketOptions = {}): string => {
  const env = options.env ?? process.env;
  if (options.socketPath !== undefined) return options.socketPath;
  if (env.LANDO_TEST_PODMAN_SOCKET !== undefined) return env.LANDO_TEST_PODMAN_SOCKET;
  if (env.DOCKER_HOST !== undefined) return stripUnixPrefix(env.DOCKER_HOST);
  const platform = options.platform ?? platformFromProcess();
  return defaultPodmanSocket(platform, env);
};

const bindMountPerformanceForPlatform = (
  platform: HostPlatform,
): ProviderCapabilities["bindMountPerformance"] => {
  if (platform === "linux") return "native";
  if (platform === "darwin" || platform === "win32") return "slow";
  return "none";
};

/**
 * Capability matrix for the user-installed Podman provider.
 *
 * Linux: `bindMountPerformance: "native"` because we talk straight to the
 * rootless Podman socket (no VM mediation).
 * macOS / Windows: `"slow"` because the user's Podman runs inside a managed
 * Podman Desktop VM.
 */
export const podmanCapabilitiesForPlatform = (platform: HostPlatform): ProviderCapabilities =>
  Schema.decodeSync(ProviderCapabilities)({
    artifactBuild: false,
    artifactPull: false,
    buildSecrets: false,
    buildSsh: false,
    multiServiceApply: true,
    serviceExec: true,
    serviceLogs: true,
    serviceHealth: "lando",
    hostReachability: "emulated",
    sharedCrossAppNetwork: false,
    persistentStorage: true,
    bindMounts: platform === "linux" || platform === "darwin" || platform === "win32",
    bindMountPerformance: bindMountPerformanceForPlatform(platform),
    copyMounts: false,
    hostPortPublish: "proxy",
    routeProvider: false,
    tlsCertificates: "none",
    rootless: true,
    privilegedServices: false,
    composeSpec: "portable",
    providerExtensions: [],
  });

export const linuxPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("linux");
export const macosPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("darwin");
export const windowsPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("win32");

export const decodeProviderCapabilities = (input: unknown) =>
  Schema.decodeUnknown(ProviderCapabilities)(input).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderCapabilityError({
          providerId: PROVIDER_ID,
          operation: "capabilities",
          message: "provider-podman returned invalid ProviderCapabilities.",
          capability: "ProviderCapabilities",
          requiredValue: "@lando/sdk/schema ProviderCapabilities",
          actualValue: input,
          cause,
        }),
    ),
  );

interface ProviderLandoSetupState {
  readonly podmanVersion?: string;
  readonly runtimeBundleVersion?: string;
  readonly runtimeBundleSha256?: string;
  readonly socketPath?: string;
}

const readProviderLandoSetupState = async (
  stateDir: string,
): Promise<{ readonly path: string; readonly state: ProviderLandoSetupState } | undefined> => {
  const path = providerLandoStatePath(stateDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    return { path, state: parsed as ProviderLandoSetupState };
  } catch {
    return undefined;
  }
};

const normalizeSocketPath = (value: string): string => stripUnixPrefix(value).replace(/\/+$/u, "");

/**
 * Default conflict detector: reads `<stateDir>/provider-lando/setup-state.json`
 * and fails with `ProviderLandoConflictError` if its recorded `socketPath`
 * matches the socket this provider would target.
 *
 * `stateDir` here is the *root* state directory passed to the registry
 * (typically `<userDataRoot>/providers`), not `provider-lando`'s subdirectory.
 */
export const detectProviderLandoConflict = (
  stateDir: string,
  socketPath: string,
): Effect.Effect<void, ProviderLandoConflictError> =>
  Effect.tryPromise({
    try: () => readProviderLandoSetupState(stateDir),
    catch: () => undefined,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
    Effect.flatMap((record) => {
      if (record === undefined) return Effect.void;
      const recordedSocket = record.state.socketPath;
      if (recordedSocket === undefined || recordedSocket.length === 0) return Effect.void;
      if (normalizeSocketPath(recordedSocket) !== normalizeSocketPath(socketPath)) return Effect.void;
      return Effect.fail(
        new ProviderLandoConflictError({
          socketPath,
          providerLandoStatePath: record.path,
        }),
      );
    }),
  );

const noConflict = (): Effect.Effect<void, ProviderLandoConflictError> => Effect.void;

export interface ProviderLayerOptions {
  readonly podmanApi?: PodmanApiClient;
  readonly podmanApiFactory?: (socketPath: string) => PodmanApiClient;
  readonly socketPath?: string;
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * State directory under which `provider-lando/setup-state.json` is read for
   * conflict detection. Typically `<userDataRoot>/providers`.
   */
  readonly stateDir?: string;
  /**
   * Overrides the default file-based conflict detector. Tests use this seam
   * to assert that the conflict-detection branch can be bypassed safely.
   */
  readonly conflictDetector?: (socketPath: string) => Effect.Effect<void, ProviderLandoConflictError>;
  readonly eventService?: BringUpOptions["eventService"];
}

const makeUnavailable = (operation: string) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: `provider-podman does not implement ${operation} yet.`,
  });

const makeNoPlanError = (appId: AppId, operation: string) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: `No applied plan found for app "${appId}". provider-podman does implement ${operation}, but the app must be started first.`,
    remediation:
      "Run `lando start` (or `lando app:start`) to start the app, then retry. Alternatively, pass an AppPlan directly via `target.plan`.",
  });

const podmanUnavailable = (operation: string, socketPath: string, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation,
    message: `The Podman socket "${socketPath}" is not reachable.`,
    remediation:
      "Ensure your user-installed Podman is running (e.g. `systemctl --user start podman.socket` on Linux). Verify the socket path or `DOCKER_HOST` env. Run `lando doctor` for a full diagnostic.",
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Construct a `RuntimeProvider` Live Layer service for the user-installed
 * Podman host. Fails closed with `ProviderLandoConflictError` if
 * `@lando/provider-lando`'s persisted setup-state claims the same socket.
 */
export const makeRuntimeProvider = (
  options: ProviderLayerOptions = {},
): Effect.Effect<RuntimeProviderShape, ProviderCapabilityError | ProviderUnavailableError> => {
  const plans = new Map<string, AppPlan>();
  const platform = options.platform ?? platformFromProcess();
  const socketPath = resolvePodmanSocket({
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    platform,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const podmanApi = options.podmanApi ?? (options.podmanApiFactory ?? makePodmanApiClient)(socketPath);

  const conflictCheck =
    options.conflictDetector !== undefined
      ? options.conflictDetector(socketPath)
      : options.stateDir === undefined
        ? noConflict()
        : detectProviderLandoConflict(options.stateDir, socketPath);

  // We only use the lando layer's capability *probe* to confirm the socket is healthy;
  // the capability values themselves are provider-podman-specific.
  const capabilities = introspectProviderCapabilities(podmanApi, platform).pipe(
    Effect.map(() => podmanCapabilitiesForPlatform(platform)),
    Effect.mapError((cause) => {
      if (cause instanceof ProviderUnavailableError)
        return podmanUnavailable("capabilities", socketPath, cause);
      return cause;
    }),
  );

  const resolvePlan = (target: AppSelector): Effect.Effect<AppPlan | undefined, never> => {
    if (target.plan !== undefined) return Effect.succeed(target.plan);
    return Effect.succeed(plans.get(target.app));
  };

  return conflictCheck.pipe(
    Effect.flatMap(() => capabilities),
    Effect.map(
      (resolvedCapabilities): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        displayName: "Podman Runtime Provider (user-installed)",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: Effect.succeed(true),
        // No managed setup: user already installed Podman.
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0" }),
        buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
        pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, {
            podmanApi,
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                plans.set(plan.id, plan);
              }),
            ),
          ),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        destroy: (target, destroyOptions) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return;
            yield* bringDown(plan, { podmanApi, volumes: destroyOptions.volumes });
            if (destroyOptions.removeState !== false) {
              plans.delete(target.app);
            }
          }),
        exec: (target, command) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "exec"));
            return yield* exec(plan, target, command, { podmanApi });
          }),
        execStream: (target, command) =>
          Stream.unwrap(
            resolvePlan(target).pipe(
              Effect.map((plan) =>
                plan === undefined
                  ? Stream.fail(makeNoPlanError(target.app, "execStream"))
                  : execStream(plan, target, command, { podmanApi }),
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
                  : logs(plan, target, logOptions, { podmanApi }),
              ),
            ),
          ),
        inspect: (target) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return yield* Effect.fail(makeNoPlanError(target.app, "inspect"));
            const snapshot = yield* inspect(plan, target, { podmanApi });
            return { ...snapshot, providerId: providerIdBranded };
          }),
        list: (filter) =>
          Effect.forEach(Array.from(plans.values()), (plan) =>
            Effect.forEach(Object.values(plan.services), (service) =>
              inspect(plan, { app: plan.id, service: service.name }, { podmanApi }).pipe(
                Effect.map((snapshot) => ({ ...snapshot, providerId: providerIdBranded })),
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
  description: "Opt-in user-installed Podman RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: [PROVIDER_ID] },
  entry: "./src/index.ts",
});

export { makePodmanApiClient } from "@lando/provider-lando";
export type { PodmanApiClient } from "@lando/provider-lando";
