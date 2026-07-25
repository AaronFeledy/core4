import { rm } from "node:fs/promises";

import { Effect } from "effect";

import type { ProviderUnavailableError } from "@lando/sdk/errors";

import type { PodmanApiClient } from "./capabilities.ts";
import type { LinuxRuntimeFilesystem, RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import { type PodmanServiceRunner, buildPodmanServiceArgs } from "./podman-service-runner.ts";
import { launchStatePath, recordedLaunchMatchesSpec } from "./runtime-launch-state.ts";

export interface LinuxRuntimeHealthDeps {
  readonly podmanApi: PodmanApiClient;
  readonly serviceRunner: PodmanServiceRunner;
  readonly podmanBin: string;
  readonly storageDir: string;
  readonly runRoot: string;
  readonly configDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly runtimeBundleVersion?: string;
  readonly generationStore?: RuntimeGenerationStore;
  readonly bootIdReader?: () => Effect.Effect<string, unknown>;
  readonly pidNamespaceReader?: () => Effect.Effect<string, unknown>;
  readonly filesystem?: LinuxRuntimeFilesystem;
}

const currentRuntimeIsOwned = (deps: LinuxRuntimeHealthDeps): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pid = yield* readRuntimePid(deps.pidPath);
    if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return false;
    const spec = buildPodmanServiceArgs(deps);
    const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(pid, spec) ?? Effect.succeed(false);
    return (
      serviceProcess && (yield* recordedLaunchMatchesSpec(deps.pidPath, pid, spec, deps.runtimeBundleVersion))
    );
  });

export const linuxRuntimeIsHealthy = (
  deps: LinuxRuntimeHealthDeps,
): Effect.Effect<boolean, ProviderUnavailableError> =>
  Effect.either(deps.podmanApi.ping).pipe(
    Effect.flatMap((reachable) =>
      reachable._tag === "Left" ? Effect.succeed(false) : currentRuntimeIsOwned(deps),
    ),
  );

const findAliveServicePids = (
  deps: LinuxRuntimeHealthDeps,
  find:
    | ((spec: ReturnType<typeof buildPodmanServiceArgs>) => Effect.Effect<ReadonlyArray<number>>)
    | undefined,
): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    if (find === undefined) return [];
    const pids = yield* find(buildPodmanServiceArgs(deps));
    const alive: number[] = [];
    for (const pid of pids) {
      if (yield* deps.serviceRunner.isAlive(pid)) alive.push(pid);
    }
    return alive;
  });

export const stopDiscoveredRuntimeProcesses = (deps: LinuxRuntimeHealthDeps): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (
      deps.serviceRunner.findMatchingServicePids === undefined &&
      deps.serviceRunner.findManagedServicePids === undefined
    ) {
      return;
    }
    const matching = yield* findAliveServicePids(deps, deps.serviceRunner.findMatchingServicePids);
    const managed = yield* findAliveServicePids(deps, deps.serviceRunner.findManagedServicePids);
    for (const pid of new Set([...matching, ...managed])) {
      yield* deps.serviceRunner.terminate(pid);
    }
  });

const bestEffortRemove = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { force: true })).pipe(Effect.catchAll(() => Effect.void));

export const reapLegacyStaleRuntime = (deps: LinuxRuntimeHealthDeps): Effect.Effect<void> =>
  Effect.gen(function* () {
    const pid = yield* readRuntimePid(deps.pidPath);
    if (pid !== undefined && (yield* deps.serviceRunner.isAlive(pid))) {
      const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(
        pid,
        buildPodmanServiceArgs(deps),
      ) ?? Effect.succeed(false);
      if (serviceProcess) yield* deps.serviceRunner.terminate(pid);
    }
    yield* bestEffortRemove(deps.socketPath);
    yield* bestEffortRemove(deps.pidPath);
    yield* bestEffortRemove(launchStatePath(deps.pidPath));
  });
