import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import type { HostPlatform } from "@lando/sdk/schema";

import type { PodmanApiClient } from "./capabilities.ts";
import {
  type PodmanServiceRunner,
  type RuntimeLaunchError,
  buildPodmanServiceArgs,
  readPodmanServiceLogTail,
} from "./podman-service-runner.ts";
import {
  type RootlessProbes,
  classifyRootlessFailure,
  makeSystemRootlessProbes,
} from "./rootless-preflight.ts";
import { launchStatePath, recordedLaunchMatchesSpec, writeLaunchState } from "./runtime-launch-state.ts";
import { type PodmanMachineRunner, ensureMacOSPodmanMachine, ensureWindowsPodmanMachine } from "./setup.ts";

export interface EnsureRuntimeDeps {
  readonly platform: HostPlatform;
  readonly podmanApi: PodmanApiClient;
  readonly serviceRunner: PodmanServiceRunner;
  readonly machineRunner?: PodmanMachineRunner;
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly rootlessProbes?: RootlessProbes;
  readonly readinessPolicy?: RetryPolicy;
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

const missingMachineRunnerError = (platform: "darwin" | "win32") =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message: `Podman machine runner is required to ensure the Lando runtime on ${platform}.`,
    remediation: "Run `lando setup` with the bundled provider runtime available, then retry the command.",
  });

const readStalePid = (pidPath: string): Effect.Effect<number | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const raw = (await readFile(pidPath, "utf8")).trim();
      if (!/^\d+$/u.test(raw)) return undefined;
      return Number(raw);
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll((pid) => Effect.succeed(pid)));

const bestEffortRm = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { force: true })).pipe(Effect.catchAll(() => Effect.void));

const writePidFile = (pidPath: string, pid: number): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await writeFile(pidPath, String(pid));
      } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
          await mkdir(dirname(pidPath), { recursive: true });
          await writeFile(pidPath, String(pid));
          return;
        }
        throw cause;
      }
    },
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

const reapStaleRuntime = (deps: EnsureRuntimeDeps): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = yield* readStalePid(deps.pidPath);
    if (pid !== undefined) {
      const alive = yield* deps.serviceRunner.isAlive(pid);
      const serviceProcess = alive
        ? yield* deps.serviceRunner.isServiceProcess?.(pid, buildPodmanServiceArgs(deps)) ??
            Effect.succeed(false)
        : false;
      if (serviceProcess) {
        yield* deps.serviceRunner.terminate(pid);
      }
    }

    yield* bestEffortRm(deps.socketPath);
    yield* bestEffortRm(deps.pidPath);
    yield* bestEffortRm(launchStatePath(deps.pidPath));
  });

const currentRuntimeIsOwned = (deps: EnsureRuntimeDeps): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pid = yield* readStalePid(deps.pidPath);
    if (pid === undefined) return false;

    const alive = yield* deps.serviceRunner.isAlive(pid);
    if (!alive) return false;

    const spec = buildPodmanServiceArgs(deps);
    const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(pid, spec) ?? Effect.succeed(false);
    if (!serviceProcess) return false;

    return yield* recordedLaunchMatchesSpec(deps.pidPath, pid, spec);
  });

const findAliveServicePids = (
  deps: EnsureRuntimeDeps,
  find:
    | ((spec: ReturnType<typeof buildPodmanServiceArgs>) => Effect.Effect<ReadonlyArray<number>>)
    | undefined,
): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    if (find === undefined) return [];

    const spec = buildPodmanServiceArgs(deps);
    const pids = yield* find(spec);
    const alive: number[] = [];
    for (const pid of pids) {
      if (yield* deps.serviceRunner.isAlive(pid)) alive.push(pid);
    }
    return alive;
  });

const findAliveMatchingServicePids = (deps: EnsureRuntimeDeps): Effect.Effect<ReadonlyArray<number>> =>
  findAliveServicePids(deps, deps.serviceRunner.findMatchingServicePids);

const findAliveManagedServicePids = (deps: EnsureRuntimeDeps): Effect.Effect<ReadonlyArray<number>> =>
  findAliveServicePids(deps, deps.serviceRunner.findManagedServicePids);

const launchRuntime = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const spec = buildPodmanServiceArgs({
      podmanBin: deps.podmanBin,
      storageDir: deps.storageDir,
      runRoot: deps.runRoot,
      configDir: deps.configDir,
      socketPath: deps.socketPath,
    });

    const pid = yield* deps.serviceRunner.launch(spec).pipe(
      Effect.catchAll((launchError: RuntimeLaunchError) => {
        const probes = deps.rootlessProbes ?? makeSystemRootlessProbes();
        const rootlessError = classifyRootlessFailure(probes.probe(), launchError.stderr);
        return Effect.fail(rootlessError ?? launchError);
      }),
    );

    yield* writePidFile(deps.pidPath, pid);
    yield* writeLaunchState(deps.pidPath, pid, spec);
  });

const verifyRuntimeReachable = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> =>
  runProbe(
    {
      id: "provider-lando-runtime-ready",
      policy: deps.readinessPolicy ?? defaultRuntimeReadinessPolicy,
    },
    deps.platform === "win32"
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
                    deps.platform === "win32"
                      ? `The Lando runtime service did not become reachable at ${deps.socketPath} after launch.`
                      : "The Lando runtime service did not become reachable after launch.",
                  remediation:
                    "Run `lando doctor` to inspect the runtime service, then rerun the command; run `lando setup` if the runtime is not installed.",
                  details: {
                    attempts: result.attempts,
                    elapsedMs: result.elapsedMs,
                    ...(stderr === undefined ? {} : { stderr }),
                  },
                  cause: result.lastError,
                }),
              ),
            ),
          ),
    ),
    Effect.mapError((cause) =>
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

const ensureLinuxRuntime = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const reachable = yield* Effect.either(deps.podmanApi.ping);
    if (reachable._tag === "Right") {
      const owned = yield* currentRuntimeIsOwned(deps);
      if (owned) return;

      if (
        deps.serviceRunner.findMatchingServicePids !== undefined ||
        deps.serviceRunner.findManagedServicePids !== undefined
      ) {
        const matchingPids = yield* findAliveMatchingServicePids(deps);
        const managedPids = yield* findAliveManagedServicePids(deps);
        const pidsToStop = [...new Set([...matchingPids, ...managedPids])];
        if (pidsToStop.length === 0) {
          const stalePid = yield* readStalePid(deps.pidPath);
          if (stalePid !== undefined) {
            const staleAlive = yield* deps.serviceRunner.isAlive(stalePid);
            const serviceProcess =
              staleAlive &&
              (yield* deps.serviceRunner.isServiceProcess?.(stalePid, buildPodmanServiceArgs(deps)) ??
                Effect.succeed(false));
            if (serviceProcess) {
              yield* deps.serviceRunner.terminate(stalePid);
            }
          }
        } else {
          for (const pid of pidsToStop) {
            yield* deps.serviceRunner.terminate(pid);
          }
        }
      }
    }

    yield* reapStaleRuntime(deps);
    yield* launchRuntime(deps);
    yield* verifyRuntimeReachable(deps);
  });

export const ensureRuntime = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> => {
  if (deps.platform === "darwin") {
    return deps.machineRunner === undefined
      ? Effect.fail(missingMachineRunnerError("darwin"))
      : ensureMacOSPodmanMachine(deps.machineRunner).pipe(Effect.andThen(verifyRuntimeReachable(deps)));
  }

  if (deps.platform === "win32") {
    return deps.machineRunner === undefined
      ? Effect.fail(missingMachineRunnerError("win32"))
      : ensureWindowsPodmanMachine(deps.machineRunner).pipe(Effect.andThen(verifyRuntimeReachable(deps)));
  }

  return ensureLinuxRuntime(deps);
};
