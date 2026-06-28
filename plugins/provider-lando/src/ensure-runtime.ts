import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { HostPlatform } from "@lando/sdk/schema";

import type { PodmanApiClient } from "./capabilities.ts";
import {
  type PodmanServiceRunner,
  type RuntimeLaunchError,
  buildPodmanServiceArgs,
} from "./podman-service-runner.ts";
import {
  type RootlessProbes,
  classifyRootlessFailure,
  makeSystemRootlessProbes,
} from "./rootless-preflight.ts";
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
}

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
  });

const currentRuntimeIsOwned = (deps: EnsureRuntimeDeps): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pid = yield* readStalePid(deps.pidPath);
    if (pid === undefined) return false;

    const alive = yield* deps.serviceRunner.isAlive(pid);
    if (!alive) return false;

    return yield* deps.serviceRunner.isServiceProcess?.(pid, buildPodmanServiceArgs(deps)) ??
      Effect.succeed(false);
  });

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
  });

const verifyRuntimeReachable = (deps: EnsureRuntimeDeps): Effect.Effect<void, ProviderUnavailableError> =>
  runProbe(
    {
      id: "provider-lando-runtime-ready",
      policy: { maxAttempts: 10, delay: Duration.millis(100), timeout: Duration.seconds(5) },
    },
    deps.podmanApi.info,
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? Effect.void
        : Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "setup",
              message: "The Lando runtime service did not become reachable after launch.",
              remediation:
                "Run `lando doctor` to inspect the runtime service, then rerun the command; run `lando setup` if the runtime is not installed.",
              details: { attempts: result.attempts },
              cause: result.lastError,
            }),
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
    const reachable = yield* Effect.either(deps.podmanApi.info);
    if (reachable._tag === "Right") {
      const owned = yield* currentRuntimeIsOwned(deps);
      if (owned) return;
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
