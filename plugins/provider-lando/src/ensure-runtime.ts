import { dirname } from "node:path";
import { resolveManagedRuntimeDir } from "@lando/container-runtime/podman/managed-runtime-dir";
import { mapFailures } from "@lando/sdk/command-result";
import { Duration, Effect, Exit } from "effect";

import { redactDetails, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";
import { writeFileAtomic } from "@lando/state-store/atomic";

import { rejectIntelMacHost } from "./host-support.ts";
import { validateManagedSocketPathLength } from "./managed-runtime-socket-path.ts";
import type { ArtifactDownload } from "./runtime-bundle.ts";

import { type EnsureManagedCatatonitOptions, ensureManagedCatatonit } from "./catatonit-provision.ts";
import {
  type ContainerCgroups,
  type DelegatedScopeHost,
  delegatedLaunchEligibility,
  observeServicePlacement,
  processCgroupPath,
} from "./delegated-scope.ts";
import { adoptHealthyRuntimeGeneration } from "./linux-runtime-generation.ts";
import {
  type LinuxRuntimeHealthDeps,
  countRunningContainers,
  linuxRuntimeHasOwnedService,
  linuxRuntimeIsHealthy,
  reapLegacyStaleRuntime,
  stopDiscoveredRuntimeProcesses,
  verifyReplacedServiceTransition,
} from "./linux-runtime-health.ts";
import { reapStaleLinuxRuntime } from "./linux-runtime-reaper.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import { ensureManagedNft } from "./nft-provision.ts";
import {
  type PodmanServiceScope,
  type PodmanServiceSpec,
  type RuntimeLaunchError,
  buildPodmanServiceArgs,
  podmanServiceLogPath,
  readPodmanServiceLogTail,
} from "./podman-service-runner.ts";
import {
  type RootlessProbes,
  classifyRootlessFailure,
  makeSystemRootlessProbes,
} from "./rootless-preflight.ts";
import { writeManagedRuntimeContainersConf } from "./runtime-config.ts";
import {
  recordServicePlacement,
  recordedContainerCgroups,
  writeLaunchState,
} from "./runtime-launch-state.ts";
import { type PodmanMachineRunner, ensureMacOSPodmanMachine, ensureWindowsPodmanMachine } from "./setup.ts";

const hostSecretsRedactor = () => standaloneSecretsRedactor({ ...process.env });

export interface EnsureRuntimeDeps extends Omit<LinuxRuntimeHealthDeps, "privateRuntimeDir"> {
  readonly privateRuntimeDir?: string | undefined;
  readonly platform: HostPlatform;
  readonly arch?: string;
  readonly prepareNativeInit?: boolean;
  readonly runtimeBinDir?: string;
  readonly nftProvision?: {
    readonly download: ArtifactDownload;
    readonly cacheDir: string;
    readonly arch?: string;
  };
  readonly catatonitProvision?: EnsureManagedCatatonitOptions;
  readonly machineRunner?: PodmanMachineRunner;
  readonly rootlessProbes?: RootlessProbes;
  readonly readinessPolicy?: RetryPolicy;
  readonly withLaunchLock?: <A, E>(body: Effect.Effect<A, E>) => Effect.Effect<A, E | StateStoreError>;
  readonly terminationPolicy?: RetryPolicy;
  readonly admit?: Effect.Effect<void, ProviderUnavailableError>;
  readonly recordLaunch?: (
    pid: number,
    spec: PodmanServiceSpec,
  ) => Effect.Effect<void, ProviderUnavailableError>;
  /**
   * Host view for the delegated systemd user scope (Linux). Production always passes it; when it
   * is omitted the service launches undelegated and its placement is not observed.
   */
  readonly delegatedScope?: DelegatedScopeHost;
  readonly recordPlacement?: (
    pid: number,
    containerCgroups: ContainerCgroups,
  ) => Effect.Effect<void, ProviderUnavailableError>;
  readonly setupProgress?: {
    readonly helpers: (
      body: Effect.Effect<void, ProviderUnavailableError>,
    ) => Effect.Effect<void, ProviderUnavailableError>;
    readonly launch: (
      body: Effect.Effect<void, ProviderUnavailableError>,
    ) => Effect.Effect<void, ProviderUnavailableError>;
    readonly readiness: (
      body: Effect.Effect<void, ProviderUnavailableError>,
    ) => Effect.Effect<void, ProviderUnavailableError>;
  };
}

// ping() fails fast (connection refused) while podman is cold-starting, so the
// readiness budget must be wall-clock patience, not a small attempt count burned
// against instant refusals. A loaded CI runner can take tens of seconds to bring
// the socket up: poll twice a second for ~45s, with timeout as a per-probe cap.
const defaultRuntimeReadinessPolicy: RetryPolicy = {
  maxAttempts: 91,
  delay: Duration.millis(500),
  timeout: Duration.seconds(45),
};

const healthyMachinePolicy: RetryPolicy = {
  maxAttempts: 1,
  delay: Duration.millis(0),
  timeout: Duration.seconds(2),
};

const missingMachineRunnerError = (platform: "darwin" | "win32") =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: `Podman machine runner is required to ensure the Lando runtime on ${platform}.`,
    remediation: "Run `lando setup` with the bundled provider runtime available, then retry the command.",
  });

const writePidFile = (pidPath: string, pid: number): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: () => writeFileAtomic(pidPath, String(pid), { mode: 0o600, ownerOnly: "best-effort" }),
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "Failed to write the Lando runtime service PID file.",
        remediation: "Verify the Lando runtime directory is writable, then rerun the command.",
        details: { pidPath },
        cause,
      }),
  });

const mapLaunchLockError = (
  deps: EnsureRuntimeDeps,
  cause: ProviderUnavailableError | StateStoreError,
): ProviderUnavailableError =>
  cause instanceof StateStoreError
    ? new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "Failed to acquire the Lando runtime launch lock.",
        remediation: "Wait for the current runtime launch to finish, then retry the command.",
        details: { runRoot: deps.runRoot },
        cause,
      })
    : cause;

const launchRuntime = Effect.fn("ProviderLando.launchRuntime")(function* (
  deps: EnsureRuntimeDeps & LinuxRuntimeHealthDeps,
  scope: PodmanServiceScope | undefined,
): Effect.fn.Return<number, ProviderUnavailableError> {
  const spec = buildPodmanServiceArgs({
    podmanBin: deps.podmanBin,
    storageDir: deps.storageDir,
    runRoot: deps.runRoot,
    configDir: deps.configDir,
    socketPath: deps.socketPath,
    privateRuntimeDir: deps.privateRuntimeDir,
  });

  yield* deps.admit ?? Effect.void;
  const pid = yield* deps.serviceRunner.launch(spec, scope).pipe(
    Effect.catch((launchError: RuntimeLaunchError) => {
      const probes = deps.rootlessProbes ?? makeSystemRootlessProbes();
      const rootlessError = classifyRootlessFailure(probes.probe(), launchError.stderr);
      return Effect.fail(rootlessError ?? launchError);
    }),
  );

  const recordLaunch =
    deps.recordLaunch?.(pid, spec) ??
    writeLaunchState(deps.pidPath, pid, spec, deps.runtimeBundleVersion).pipe(
      Effect.andThen(writePidFile(deps.pidPath, pid)),
    );
  yield* recordLaunch.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? deps.serviceRunner.terminate(pid) : Effect.void)),
  );
  return pid;
});

const verifyRuntimeReachable = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> =>
  runProbe(
    {
      id: "provider-lando-runtime-ready",
      policy: deps.readinessPolicy ?? defaultRuntimeReadinessPolicy,
    },
    hostPlatformFamily(deps.platform) === "win32"
      ? deps.podmanApi.ping.pipe(Effect.andThen(deps.podmanApi.info), Effect.asVoid)
      : deps.podmanApi.ping,
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? Effect.void
        : readPodmanServiceLogTail(deps.socketPath).pipe(
            Effect.flatMap((stderr) =>
              Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "setup",
                  message:
                    hostPlatformFamily(deps.platform) === "win32"
                      ? `The Lando runtime service did not become reachable at ${deps.socketPath} after launch.`
                      : "The Lando runtime service did not become reachable after launch.",
                  remediation:
                    "Run `lando doctor` to inspect the runtime service, then rerun the command; run `lando setup` if the runtime is not installed.",
                  details: redactDetails(
                    {
                      attempts: result.attempts,
                      elapsedMs: result.elapsedMs,
                      ...(stderr === undefined ? {} : { stderr }),
                    },
                    hostSecretsRedactor(),
                  ),
                  cause: result.lastError,
                }),
              ),
            ),
          ),
    ),
    mapFailures((cause) =>
      cause instanceof ProviderUnavailableError
        ? cause
        : new ProviderUnavailableError({
            providerId: "lando",
            operation: "setup",
            message: "Failed to probe the Lando runtime service after launch.",
            remediation:
              "Run `lando doctor` to inspect the runtime service, then rerun the command; run `lando setup` if the runtime is not installed.",
            cause,
          }),
    ),
  );

/**
 * Records where the ready service runs. A launch that selected the delegated scope but did not end
 * up in a user-owned cgroup with memory, pids and cpu is stopped and fails: containers would
 * silently run without limits.
 */
const verifyServicePlacement = Effect.fnUntraced(function* (
  deps: EnsureRuntimeDeps,
  host: DelegatedScopeHost,
  pid: number,
  scope: PodmanServiceScope | undefined,
): Effect.fn.Return<void, ProviderUnavailableError> {
  const placement = observeServicePlacement(pid, host);
  if (scope !== undefined && placement !== "delegated") {
    yield* deps.serviceRunner.terminate(pid);
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message:
          "The Lando runtime service did not start in a delegated systemd user scope, so containers would not get their own cgroups.",
        remediation:
          "Run `lando doctor` to inspect the runtime placement and your systemd user manager, then rerun the command.",
        details: { pid, cgroup: processCgroupPath(pid, host) ?? "unknown", systemdRun: scope.systemdRun },
      }),
    );
  }
  yield* deps.recordPlacement?.(pid, placement) ?? recordServicePlacement(deps.pidPath, pid, placement);
});

/**
 * A healthy service launched without delegation is replaced by a delegated one when the host now
 * allows it, but only while it runs no containers: stopping it keeps the private runtime dir,
 * pause process and namespaces, and no workload is interrupted.
 */
const needsDelegatedRelaunch = Effect.fnUntraced(function* (
  deps: EnsureRuntimeDeps & LinuxRuntimeHealthDeps,
  scope: PodmanServiceScope | undefined,
): Effect.fn.Return<boolean> {
  if (scope === undefined) return false;
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || (yield* recordedContainerCgroups(deps.pidPath, pid)) === "delegated") return false;
  return (yield* countRunningContainers(deps.podmanApi)) === 0;
});

const ensureLinuxRuntime = Effect.fn("ProviderLando.ensureLinuxRuntime")(function* (
  deps: EnsureRuntimeDeps & LinuxRuntimeHealthDeps,
): Effect.fn.Return<void, ProviderUnavailableError> {
  const socketPathError = validateManagedSocketPathLength(deps.socketPath);
  if (socketPathError !== undefined) return yield* Effect.fail(socketPathError);
  const helpers = Effect.gen(function* () {
    if (deps.catatonitProvision !== undefined) {
      yield* ensureManagedCatatonit(deps.catatonitProvision);
    }
    const runtimeBinDir = deps.runtimeBinDir ?? deps.catatonitProvision?.runtimeBinDir;
    if (runtimeBinDir !== undefined) {
      yield* writeManagedRuntimeContainersConf({
        runtimeBinDir,
        runtimeConfigDir: deps.configDir,
      });
    }
    if (deps.nftProvision !== undefined) {
      const runtimeBinDir = deps.podmanBin.includes("/")
        ? deps.podmanBin.slice(0, deps.podmanBin.lastIndexOf("/"))
        : undefined;
      if (runtimeBinDir !== undefined) {
        yield* ensureManagedNft({
          runtimeBinDir,
          download: deps.nftProvision.download,
          cacheDir: deps.nftProvision.cacheDir,
          platform: deps.platform,
          arch: deps.nftProvision.arch ?? process.arch,
        });
      }
    }
  });
  const eligibility =
    deps.delegatedScope === undefined
      ? undefined
      : delegatedLaunchEligibility(deps.platform, deps.delegatedScope);
  const scope: PodmanServiceScope | undefined =
    eligibility?.eligible === true
      ? { systemdRun: eligibility.systemdRun, userRuntimeDir: eligibility.userRuntimeDir }
      : undefined;
  const repair = Effect.gen(function* () {
    yield* deps.setupProgress?.helpers(helpers) ?? helpers;
    if ((yield* linuxRuntimeIsHealthy(deps)) && !(yield* needsDelegatedRelaunch(deps, scope))) {
      const adopted =
        deps.generationStore === undefined
          ? true
          : yield* adoptHealthyRuntimeGeneration({
              storageDir: deps.storageDir,
              runRoot: deps.runRoot,
              configDir: deps.configDir,
              socketPath: deps.socketPath,
              pidPath: deps.pidPath,
              generationStore: deps.generationStore,
              ...(deps.bootIdReader === undefined ? {} : { bootIdReader: deps.bootIdReader }),
              ...(deps.pidNamespaceReader === undefined
                ? {}
                : { pidNamespaceReader: deps.pidNamespaceReader }),
              ...(deps.filesystem === undefined ? {} : { filesystem: deps.filesystem }),
            });
      if (adopted) {
        yield* deps.setupProgress?.launch(Effect.void) ?? Effect.void;
        yield* deps.setupProgress?.readiness(Effect.void) ?? Effect.void;
        return;
      }
    }
    yield* verifyReplacedServiceTransition(deps);
    if (deps.generationStore === undefined) {
      yield* stopDiscoveredRuntimeProcesses(deps);
      yield* reapLegacyStaleRuntime(deps);
    } else {
      if (yield* linuxRuntimeHasOwnedService(deps)) {
        yield* adoptHealthyRuntimeGeneration({
          ...deps,
          generationStore: deps.generationStore,
        });
      }
      yield* reapStaleLinuxRuntime({
        serviceRunner: deps.serviceRunner,
        podmanBin: deps.podmanBin,
        storageDir: deps.storageDir,
        runRoot: deps.runRoot,
        configDir: deps.configDir,
        socketPath: deps.socketPath,
        pidPath: deps.pidPath,
        generationStore: deps.generationStore,
        privateRuntimeDir: deps.privateRuntimeDir,
        ...(deps.bootIdReader === undefined ? {} : { bootIdReader: deps.bootIdReader }),
        ...(deps.pidNamespaceReader === undefined ? {} : { pidNamespaceReader: deps.pidNamespaceReader }),
        ...(deps.filesystem === undefined ? {} : { filesystem: deps.filesystem }),
        ...(deps.terminationPolicy === undefined ? {} : { terminationPolicy: deps.terminationPolicy }),
      });
    }
    let launchedPid: number | undefined;
    const launch = launchRuntime(deps, scope).pipe(
      Effect.tap((pid) =>
        Effect.sync(() => {
          launchedPid = pid;
        }),
      ),
      Effect.asVoid,
    );
    yield* deps.setupProgress?.launch(launch) ?? launch;
    const earlyExit =
      launchedPid === undefined
        ? undefined
        : deps.serviceRunner.waitForExit?.(launchedPid).pipe(
            Effect.flatMap((exitCode) =>
              readPodmanServiceLogTail(deps.socketPath).pipe(
                Effect.flatMap((stderr) => {
                  const classified = classifyRootlessFailure(
                    (deps.rootlessProbes ?? makeSystemRootlessProbes()).probe(),
                    stderr,
                  );
                  const logPath = podmanServiceLogPath(deps.socketPath);
                  return Effect.fail(
                    new ProviderUnavailableError({
                      providerId: "lando",
                      operation: "setup",
                      message:
                        classified?.message ??
                        `The managed Podman service exited before becoming ready (exit ${exitCode}).`,
                      remediation: `${classified?.remediation ?? "Check the managed Podman startup failure."} Inspect ${logPath}, then rerun the command.`,
                      details: redactDetails(
                        {
                          exitCode,
                          logPath,
                          stderr,
                          ...(classified === undefined ? {} : { prerequisite: classified.prerequisite }),
                        },
                        hostSecretsRedactor(),
                      ),
                    }),
                  );
                }),
              ),
            ),
          );
    const reachable =
      earlyExit === undefined
        ? verifyRuntimeReachable(deps)
        : Effect.raceFirst(verifyRuntimeReachable(deps), earlyExit);
    // Ready means the launcher has exec'd into Podman, so the observed cgroup is the service's own.
    const readiness =
      launchedPid === undefined || deps.delegatedScope === undefined
        ? reachable
        : reachable.pipe(
            Effect.andThen(verifyServicePlacement(deps, deps.delegatedScope, launchedPid, scope)),
          );
    yield* deps.setupProgress?.readiness(readiness) ?? readiness;
  });
  const launchAndReadiness = (deps.withLaunchLock?.(repair) ?? repair).pipe(
    mapFailures((cause) => mapLaunchLockError(deps, cause)),
  );
  yield* launchAndReadiness;
});

const ensureMachineRuntime = (
  deps: EnsureRuntimeDeps,
  machine: PodmanMachineRunner,
  launchMachine: Effect.Effect<void, ProviderUnavailableError>,
): Effect.Effect<void, ProviderUnavailableError> => {
  const healthy = runProbe(
    { id: "provider-lando-machine-healthy", policy: healthyMachinePolicy },
    hostPlatformFamily(deps.platform) === "win32"
      ? deps.podmanApi.ping.pipe(Effect.andThen(deps.podmanApi.info), Effect.asVoid)
      : deps.podmanApi.ping,
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? machine.inspect.pipe(Effect.map((status) => status === "running"))
        : Effect.succeed(false),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
  const completeProgress = Effect.gen(function* () {
    if (deps.prepareNativeInit === true) yield* machine.verifyNativeInit ?? Effect.void;
    yield* deps.setupProgress?.launch(Effect.void) ?? Effect.void;
    yield* deps.setupProgress?.readiness(Effect.void) ?? Effect.void;
  });
  const launchAndReadiness = Effect.gen(function* () {
    if (yield* healthy) {
      yield* completeProgress;
      return;
    }
    yield* deps.setupProgress?.launch(launchMachine) ?? launchMachine;
    const readiness = verifyRuntimeReachable(deps);
    yield* deps.setupProgress?.readiness(readiness) ?? readiness;
  });
  return healthy.pipe(
    Effect.flatMap((ready) =>
      ready ? completeProgress : (deps.withLaunchLock?.(launchAndReadiness) ?? launchAndReadiness),
    ),
    mapFailures((cause) => mapLaunchLockError(deps, cause)),
  );
};

export const ensureRuntime = Effect.fn("ProviderLando.ensureRuntime")(function* (
  deps: EnsureRuntimeDeps,
): Effect.fn.Return<void, ProviderUnavailableError> {
  yield* rejectIntelMacHost(deps.platform, deps.arch);
  const family = hostPlatformFamily(deps.platform);
  if (family === "darwin") {
    return yield* deps.machineRunner === undefined
      ? Effect.fail(missingMachineRunnerError("darwin"))
      : ensureMachineRuntime(
          deps,
          deps.machineRunner,
          ensureMacOSPodmanMachine(
            deps.prepareNativeInit === true
              ? deps.machineRunner
              : { ...deps.machineRunner, verifyNativeInit: Effect.void },
          ).pipe(Effect.asVoid),
        );
  }

  if (family === "win32") {
    return yield* deps.machineRunner === undefined
      ? Effect.fail(missingMachineRunnerError("win32"))
      : ensureMachineRuntime(
          deps,
          deps.machineRunner,
          ensureWindowsPodmanMachine(
            deps.prepareNativeInit === true
              ? deps.machineRunner
              : { ...deps.machineRunner, verifyNativeInit: Effect.void },
          ).pipe(Effect.asVoid),
        );
  }

  const privateRuntimeDir =
    deps.privateRuntimeDir ?? (yield* resolveManagedRuntimeDir(dirname(deps.runRoot)));
  return yield* ensureLinuxRuntime({ ...deps, privateRuntimeDir });
});
