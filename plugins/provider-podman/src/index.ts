/**
 * `@lando/provider-podman` — opt-in RuntimeProvider for a user-installed
 * Podman socket.
 *
 * Unlike `@lando/provider-lando`, this plugin does NOT manage a private Podman
 * machine. It targets an existing user-installed rootless Podman (Linux) or a
 * Podman Desktop machine on macOS / Windows.
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
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";

import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import { makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  type BringUpOptions,
  MINIMUM_PODMAN_VERSION,
  type PodmanApiClient,
  bringDown,
  bringUp,
  exec,
  execStream,
  inspect,
  logs,
  makePodmanApiClient as makeUnixPodmanApiClient,
  podmanVersionMeetsFloor,
  providerStatePath as providerLandoStatePath,
} from "@lando/provider-lando";
import { type ProviderCapabilityError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AppId,
  AppPlan,
  type HostPlatform,
  PluginManifest,
  type ProviderCapabilities,
  ProviderId,
} from "@lando/sdk/schema";
import { type AppSelector, RuntimeProvider, type RuntimeProviderShape } from "@lando/sdk/services";

import { makeNamedPipePodmanApiClient } from "./named-pipe.ts";
import { redactDetails, redactString } from "./redact.ts";

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

export class InvalidPodmanMachineNameError extends ProviderUnavailableError {
  constructor(machineName: string) {
    super({
      providerId: PROVIDER_ID,
      operation: "select",
      message: `Invalid Podman machine name "${machineName}".`,
      remediation:
        "Set LANDO_PODMAN_MACHINE or PODMAN_MACHINE_NAME to a Podman Desktop machine name containing only letters, numbers, dots, underscores, and hyphens, starting with a letter or number.",
      details: { machineName, pattern: VALID_MACHINE_NAME.source },
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

const linuxRootlessRuntimeDir = (env: Readonly<Record<string, string | undefined>>): string => {
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR;
  if (xdgRuntimeDir !== undefined && xdgRuntimeDir.length > 0) return xdgRuntimeDir.replace(/\/+$/u, "");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/run/user/${uid}`;
};

const DEFAULT_PODMAN_DESKTOP_MACHINE = "podman-machine-default" as const;
const VALID_MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Resolve the Podman Desktop machine name. Precedence:
 * `LANDO_PODMAN_MACHINE` > `PODMAN_MACHINE_NAME` > `podman-machine-default`.
 *
 * The default `podman-machine-default` matches Podman Desktop on macOS/Windows
 * (and the upstream `podman machine init` default). Overrides allow users with
 * non-default machine names (e.g. `podman-machine-default-root` for rootful)
 * to opt in without editing source.
 */
export const resolvePodmanDesktopMachine = (env: Readonly<Record<string, string | undefined>>): string => {
  const candidate = env.LANDO_PODMAN_MACHINE ?? env.PODMAN_MACHINE_NAME;
  if (candidate === undefined || candidate.length === 0) return DEFAULT_PODMAN_DESKTOP_MACHINE;
  if (!VALID_MACHINE_NAME.test(candidate)) {
    throw new InvalidPodmanMachineNameError(candidate);
  }
  return candidate;
};

const MACHINE_NOT_RUNNING_PATTERNS = [
  /ENOENT/i,
  /ECONNREFUSED/i,
  /no such file/i,
  /connection refused/i,
  /cannot connect/i,
  /could not connect/i,
  /Unable to connect/i,
  /podman.*not\s+running/i,
  /machine.*not\s+running/i,
  /Connect to .* failed/i,
  /pipe.*not\s+found/i,
  /pipe not exist/i,
  /not\s+reachable/i,
  /socket.*not\s+found/i,
];

const isLikelyMachineNotRunning = (cause: unknown): boolean => {
  if (cause === undefined || cause === null) return false;
  if (typeof cause === "string") return MACHINE_NOT_RUNNING_PATTERNS.some((re) => re.test(cause));
  if (typeof cause !== "object") return false;
  const record = cause as Record<string, unknown>;
  for (const key of ["message", "stderr", "code"]) {
    const value = record[key];
    if (typeof value === "string" && MACHINE_NOT_RUNNING_PATTERNS.some((re) => re.test(value))) return true;
  }
  if ("cause" in record) return isLikelyMachineNotRunning(record.cause);
  return false;
};

const macosPodmanDesktopSocket = (home: string, machineName: string): string =>
  `${home.replace(/\/+$/u, "")}/.local/share/containers/podman/machine/${machineName}/podman.sock`;

const windowsPodmanDesktopSocket = (machineName: string): string => `npipe://./pipe/${machineName}`;

export interface DiscoverPodmanDesktopSocketsOptions {
  readonly platform?: HostPlatform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Enumerate Podman Desktop socket candidates for the given platform/env.
 *
 * Returns the user-overridden machine first (when LANDO_PODMAN_MACHINE /
 * PODMAN_MACHINE_NAME is set) and the default `podman-machine-default`
 * second when those differ, so callers can probe both before erroring.
 * Linux returns `[]` because the rootless Podman socket lives at
 * `$XDG_RUNTIME_DIR/podman/podman.sock` and is covered by `resolvePodmanSocket`.
 */
export const discoverPodmanDesktopSockets = (
  options: DiscoverPodmanDesktopSocketsOptions = {},
): ReadonlyArray<string> => {
  const platform = options.platform ?? platformFromProcess();
  const env = options.env ?? process.env;
  if (platform === "linux") return [];

  if (platform === "darwin") {
    const home = env.HOME;
    if (home === undefined || home.length === 0) return [];
    const overrideMachine = resolvePodmanDesktopMachine(env);
    const machines: ReadonlyArray<string> =
      overrideMachine === DEFAULT_PODMAN_DESKTOP_MACHINE
        ? [DEFAULT_PODMAN_DESKTOP_MACHINE]
        : [overrideMachine, DEFAULT_PODMAN_DESKTOP_MACHINE];
    return machines.map((machine) => macosPodmanDesktopSocket(home, machine));
  }

  const overrideMachine = resolvePodmanDesktopMachine(env);
  const machines: ReadonlyArray<string> =
    overrideMachine === DEFAULT_PODMAN_DESKTOP_MACHINE
      ? [DEFAULT_PODMAN_DESKTOP_MACHINE]
      : [overrideMachine, DEFAULT_PODMAN_DESKTOP_MACHINE];
  return machines.map((machine) => windowsPodmanDesktopSocket(machine));
};

const defaultPodmanSocket = (
  platform: HostPlatform,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  if (platform === "linux") {
    return `${linuxRootlessRuntimeDir(env)}/podman/podman.sock`;
  }
  if (platform === "darwin") {
    return discoverPodmanDesktopSockets({ platform, env })[0] ?? "/var/run/podman/podman.sock";
  }
  return windowsPodmanDesktopSocket(resolvePodmanDesktopMachine(env));
};

/**
 * Resolve the Podman socket path following the discovery precedence:
 *
 * 1. Explicit `socketPath` option.
 * 2. `LANDO_TEST_PODMAN_SOCKET` env.
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
  buildProviderCapabilities({
    bindMounts: platform === "linux" || platform === "darwin" || platform === "win32",
    bindMountPerformance: bindMountPerformanceForPlatform(platform),
    volumeSnapshot: "copy",
    serviceFileCopy: "native",
    artifactExport: true,
    artifactImport: true,
    ephemeralMounts: true,
    tlsCertificates: "none",
    rootless: true,
    composeSpec: "portable",
    providerExtensions: [],
  });

export const linuxPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("linux");
export const macosPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("darwin");
export const windowsPodmanCapabilities: ProviderCapabilities = podmanCapabilitiesForPlatform("win32");

interface ProviderLandoSetupState {
  readonly podmanVersion?: string;
  readonly runtimeBundleVersion?: string;
  readonly runtimeBundleSha256?: string;
  readonly socketPath?: string;
}

export class ProviderLandoStateError extends ProviderUnavailableError {
  constructor(args: { readonly providerLandoStatePath: string; readonly cause?: unknown }) {
    super({
      providerId: PROVIDER_ID,
      operation: "select",
      message: `Unable to read @lando/provider-lando setup state at ${args.providerLandoStatePath}.`,
      remediation:
        "Repair or remove the provider-lando setup state, then rerun `lando setup --provider=podman`.",
      details: { providerLandoStatePath: args.providerLandoStatePath },
      ...(args.cause === undefined ? {} : { cause: args.cause }),
    });
  }
}

export class UnsupportedPodmanSocketError extends ProviderUnavailableError {
  constructor(socketPath: string) {
    super({
      providerId: PROVIDER_ID,
      operation: "select",
      message:
        "provider-podman currently supports local Unix sockets and Windows Podman Desktop named pipes only.",
      remediation:
        "Set DOCKER_HOST to a unix:// Podman socket, unset it to use the platform default, or on Windows use the Podman Desktop npipe://./pipe/<machine> socket.",
      details: { socketPath: redactString(socketPath) },
    });
  }
}

export class PodmanMachineNotRunningError extends ProviderUnavailableError {
  constructor(args: {
    readonly platform: "darwin" | "win32";
    readonly machineName: string;
    readonly socketPath: string;
    readonly cause?: unknown;
  }) {
    const startCommand = `podman machine start ${args.machineName}`;
    const desktopApp = args.platform === "darwin" ? "Podman Desktop on macOS" : "Podman Desktop on Windows";
    super({
      providerId: PROVIDER_ID,
      operation: "machine",
      message: `Podman machine "${args.machineName}" is not running at "${args.socketPath}".`,
      remediation: `Open ${desktopApp} and start the "${args.machineName}" machine, or run \`${startCommand}\`. If you use a non-default machine name, set LANDO_PODMAN_MACHINE to the correct name.`,
      details: { socketPath: args.socketPath, machineName: args.machineName, platform: args.platform },
      ...(args.cause === undefined ? {} : { cause: args.cause }),
    });
  }
}

const readProviderLandoSetupState = async (
  stateDir: string,
): Promise<{ readonly path: string; readonly state: ProviderLandoSetupState } | undefined> => {
  const path = providerLandoStatePath(stateDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new ProviderLandoStateError({ providerLandoStatePath: path });
    }
    if ("socketPath" in parsed && parsed.socketPath !== undefined && typeof parsed.socketPath !== "string") {
      throw new ProviderLandoStateError({ providerLandoStatePath: path });
    }
    return { path, state: parsed as ProviderLandoSetupState };
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    if (cause instanceof ProviderLandoStateError) throw cause;
    throw new ProviderLandoStateError({ providerLandoStatePath: path, cause });
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
): Effect.Effect<void, ProviderLandoConflictError | ProviderLandoStateError> =>
  Effect.tryPromise({
    try: () => readProviderLandoSetupState(stateDir),
    catch: (cause) => cause as ProviderLandoStateError,
  }).pipe(
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

const noConflict = (): Effect.Effect<void, ProviderLandoConflictError | ProviderLandoStateError> =>
  Effect.void;

const unsupportedSocket = (
  platform: HostPlatform,
  socketPath: string,
): UnsupportedPodmanSocketError | undefined => {
  if (
    socketPath.includes("://") &&
    !socketPath.startsWith("unix://") &&
    !(platform === "win32" && socketPath.startsWith("npipe:"))
  ) {
    return new UnsupportedPodmanSocketError(socketPath);
  }
  return undefined;
};

export const makePodmanApiClient = (socketPath: string): PodmanApiClient =>
  socketPath.startsWith("npipe:")
    ? makeNamedPipePodmanApiClient(socketPath)
    : makeUnixPodmanApiClient(socketPath);

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

const APPLIED_STATE_VERSION = 1;

const appliedPlansDir = (stateDir: string): string => `${trimTrailingSlashes(stateDir)}/provider-podman/apps`;
const appliedPlanPath = (stateDir: string, appId: AppId): string =>
  `${appliedPlansDir(stateDir)}/${appId}.json`;

const persistAppliedPlan = (stateDir: string, plan: AppPlan): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = appliedPlansDir(stateDir);
      await mkdir(dir, { recursive: true });
      await writeFile(
        appliedPlanPath(stateDir, plan.id),
        `${JSON.stringify(
          {
            version: APPLIED_STATE_VERSION,
            providerId: PROVIDER_ID,
            appId: plan.id,
            plan: Schema.encodeSync(AppPlan)(plan),
          },
          null,
          2,
        )}\n`,
      );
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: PROVIDER_ID,
        operation: "applied-state.persist",
        message: "Unable to write provider-podman applied plan state.",
        remediation: `Check permissions for ${stateDir} and rerun the failing lifecycle command.`,
        cause,
      }),
  });

const loadAppliedPlan = (stateDir: string, appId: AppId): Effect.Effect<AppPlan | undefined, never> =>
  Effect.tryPromise({
    try: () => readFile(appliedPlanPath(stateDir, appId), "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
    Effect.map((content) => {
      if (content === undefined) return undefined;
      try {
        const envelope = JSON.parse(content) as unknown;
        if (
          typeof envelope !== "object" ||
          envelope === null ||
          !("version" in envelope) ||
          envelope.version !== APPLIED_STATE_VERSION ||
          !("plan" in envelope)
        ) {
          return undefined;
        }
        const decoded = Schema.decodeUnknownEither(AppPlan)(envelope.plan);
        return decoded._tag === "Right" ? decoded.right : undefined;
      } catch {
        return undefined;
      }
    }),
  );

const removeAppliedPlan = (stateDir: string, appId: AppId): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: () => unlink(appliedPlanPath(stateDir, appId)),
    catch: (cause) => cause,
  }).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
  );

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
  readonly conflictDetector?: (
    socketPath: string,
  ) => Effect.Effect<void, ProviderLandoConflictError | ProviderLandoStateError>;
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
 * Tagged subclass of `ProviderUnavailableError` raised when the user-installed
 * Podman server reports a version below the supported runtime floor. The
 * server version comes from the `/libpod/info` payload already fetched for
 * provider availability; no `podman` CLI command is executed.
 */
export class PodmanServerVersionUnsupportedError extends ProviderUnavailableError {
  constructor(observedVersion: string) {
    super({
      providerId: PROVIDER_ID,
      operation: "select",
      message: `Podman server version "${observedVersion}" (reported by the Podman API /libpod/info) does not satisfy the required minimum ${MINIMUM_PODMAN_VERSION}.`,
      details: {
        observedVersion,
        source: "libpod-info",
        minimumVersion: MINIMUM_PODMAN_VERSION,
      },
      remediation: `Upgrade Podman Desktop or your system Podman to >= ${MINIMUM_PODMAN_VERSION}, then retry.`,
    });
  }
}

const infoServerVersion = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const version = "version" in info ? info.version : undefined;
  if (typeof version !== "object" || version === null || !("Version" in version)) return undefined;
  const serverVersion = version.Version;
  return typeof serverVersion === "string" ? serverVersion : undefined;
};

const enforceServerVersionFloor = (
  info: unknown,
): Effect.Effect<string, PodmanServerVersionUnsupportedError> => {
  const observed = infoServerVersion(info);
  if (observed === undefined) {
    return Effect.fail(new PodmanServerVersionUnsupportedError("unknown"));
  }
  return podmanVersionMeetsFloor(observed, MINIMUM_PODMAN_VERSION)
    ? Effect.succeed(observed)
    : Effect.fail(new PodmanServerVersionUnsupportedError(observed));
};

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
  const effectiveEnv = options.env ?? process.env;
  let socketPath: string;
  try {
    socketPath = resolvePodmanSocket({
      ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
      platform,
      env: effectiveEnv,
    });
  } catch (cause) {
    if (cause instanceof ProviderUnavailableError) return Effect.fail(cause);
    throw cause;
  }
  const unsupportedSocketError =
    options.podmanApi === undefined ? unsupportedSocket(platform, socketPath) : undefined;
  if (unsupportedSocketError !== undefined) return Effect.fail(unsupportedSocketError);
  const podmanApi = options.podmanApi ?? (options.podmanApiFactory ?? makePodmanApiClient)(socketPath);

  let desktopMachineName: string | undefined;
  if (platform === "darwin" || platform === "win32") {
    // Resolve eagerly so an invalid LANDO_PODMAN_MACHINE surfaces as a typed
    // ProviderUnavailableError instead of throwing synchronously inside the
    // Effect.mapError below (which would become a Cause.Die defect).
    try {
      desktopMachineName = resolvePodmanDesktopMachine(effectiveEnv);
    } catch (cause) {
      if (cause instanceof ProviderUnavailableError) return Effect.fail(cause);
      throw cause;
    }
  }

  const conflictCheck =
    options.conflictDetector !== undefined
      ? options.conflictDetector(socketPath)
      : options.stateDir === undefined
        ? noConflict()
        : detectProviderLandoConflict(options.stateDir, socketPath);

  const gatedRuntime = podmanApi.info.pipe(
    Effect.flatMap((info) =>
      enforceServerVersionFloor(info).pipe(
        Effect.map((serverVersion) => ({
          serverVersion,
          capabilities: podmanCapabilitiesForPlatform(platform),
        })),
      ),
    ),
    Effect.mapError((cause) => {
      if (cause instanceof PodmanServerVersionUnsupportedError) return cause;
      if (cause instanceof ProviderUnavailableError) {
        if ((platform === "darwin" || platform === "win32") && isLikelyMachineNotRunning(cause)) {
          return new PodmanMachineNotRunningError({
            platform,
            machineName: desktopMachineName ?? resolvePodmanDesktopMachine(effectiveEnv),
            socketPath,
            cause,
          });
        }
        return podmanUnavailable("capabilities", socketPath, cause);
      }
      return cause;
    }),
  );
  const dataPlane = makeProviderDataPlane({
    providerId: PROVIDER_ID,
    api: podmanApi,
    snapshotMode: "copy",
    redactDetails,
  });

  const resolvePlan = (target: AppSelector): Effect.Effect<AppPlan | undefined, never> => {
    if (target.plan !== undefined) return Effect.succeed(target.plan);
    const cached = plans.get(target.app);
    if (cached !== undefined) return Effect.succeed(cached);
    if (options.stateDir === undefined) return Effect.succeed(undefined);
    return loadAppliedPlan(options.stateDir, target.app).pipe(
      Effect.tap((loaded) =>
        Effect.sync(() => {
          if (loaded !== undefined) plans.set(target.app, loaded);
        }),
      ),
    );
  };

  const rememberPlan = (plan: AppPlan): Effect.Effect<void, ProviderUnavailableError> =>
    (options.stateDir === undefined ? Effect.void : persistAppliedPlan(options.stateDir, plan)).pipe(
      Effect.tap(() => Effect.sync(() => plans.set(plan.id, plan))),
    );

  const forgetPlan = (appId: AppId): Effect.Effect<void> =>
    (options.stateDir === undefined ? Effect.void : removeAppliedPlan(options.stateDir, appId)).pipe(
      Effect.tap(() => Effect.sync(() => plans.delete(appId))),
    );

  return conflictCheck.pipe(
    Effect.flatMap(() => gatedRuntime),
    Effect.map(
      ({ serverVersion, capabilities: resolvedCapabilities }): RuntimeProviderShape => ({
        id: PROVIDER_ID,
        displayName: "Podman Runtime Provider (user-installed)",
        version: "0.0.0",
        platform,
        capabilities: resolvedCapabilities,
        isAvailable: podmanApi.info.pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
        ),
        setup: () => Effect.void,
        getStatus: Effect.succeed({ running: true, message: "ready" }),
        getVersions: Effect.succeed({ provider: "0.0.0", runtime: serverVersion }),
        buildArtifact: () => Effect.fail(makeUnavailable("buildArtifact")),
        pullArtifact: () => Effect.fail(makeUnavailable("pullArtifact")),
        removeArtifact: () => Effect.void,
        apply: (plan, applyOptions) =>
          bringUp(plan, {
            podmanApi,
            ...(applyOptions.signal === undefined ? {} : { signal: applyOptions.signal }),
            ...(options.eventService === undefined ? {} : { eventService: options.eventService }),
          }).pipe(Effect.tap(() => rememberPlan(plan))),
        start: () => Effect.void,
        stop: () => Effect.void,
        restart: () => Effect.void,
        destroy: (target, destroyOptions) =>
          Effect.gen(function* () {
            const plan = yield* resolvePlan(target);
            if (plan === undefined) return;
            yield* bringDown(plan, {
              podmanApi,
              volumes: destroyOptions.volumes,
              ...(destroyOptions.purgeCaches === undefined
                ? {}
                : { purgeCaches: destroyOptions.purgeCaches }),
            });
            if (destroyOptions.removeState !== false) {
              yield* forgetPlan(target.app);
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
        run: dataPlane.run,
        runStream: dataPlane.runStream,
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
          Effect.gen(function* () {
            const inMemoryIds = Array.from(plans.keys());
            const stateDir = options.stateDir;
            const persistedIds: string[] =
              stateDir === undefined
                ? []
                : yield* Effect.tryPromise({
                    try: () => readdir(appliedPlansDir(stateDir)),
                    catch: (cause) => cause,
                  }).pipe(
                    Effect.catchAll(() => Effect.succeed([] as string[])),
                    Effect.map((files) =>
                      files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)),
                    ),
                  );

            const allIds = [
              ...inMemoryIds,
              ...persistedIds.map((id) => AppId.make(id)).filter((id) => !plans.has(id)),
            ] as AppId[];
            const resolved = yield* Effect.forEach(allIds, (id) => resolvePlan({ app: id }));
            const validPlans = resolved.filter((p): p is AppPlan => p !== undefined);

            const snapshots = yield* Effect.forEach(validPlans, (plan) =>
              Effect.forEach(Object.values(plan.services), (service) =>
                inspect(plan, { app: plan.id, service: service.name }, { podmanApi }).pipe(
                  Effect.map((snapshot) => ({ ...snapshot, providerId: providerIdBranded })),
                ),
              ),
            );

            const flat = snapshots.flat();
            return filter.app === undefined ? flat : flat.filter((snapshot) => snapshot.app === filter.app);
          }),
        snapshotVolume: dataPlane.snapshotVolume,
        restoreVolume: dataPlane.restoreVolume,
        listVolumes: dataPlane.listVolumes,
        removeVolume: dataPlane.removeVolume,
        copyToService: (target, spec) =>
          resolvePlan(target).pipe(
            Effect.flatMap((plan) =>
              dataPlane.copyToService(plan === undefined ? target : { ...target, plan }, spec),
            ),
          ),
        copyFromService: (target, spec) =>
          Stream.unwrap(
            resolvePlan(target).pipe(
              Effect.map((plan) =>
                dataPlane.copyFromService(plan === undefined ? target : { ...target, plan }, spec),
              ),
            ),
          ),
        exportArtifact: dataPlane.exportArtifact,
        importArtifact: dataPlane.importArtifact,
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
  requires: { "@lando/core": "^4.0.0" },
  description: "Opt-in user-installed Podman RuntimeProvider implementation.",
  enabled: true,
  contributes: { providers: [PROVIDER_ID] },
  entry: "./src/index.ts",
});

export type { PodmanApiClient } from "@lando/provider-lando";
