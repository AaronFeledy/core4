import { rm } from "node:fs/promises";

import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import type { ProviderUnavailableError } from "@lando/sdk/errors";
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

const currentRuntimeIsOwned = Effect.fnUntraced(function* (
  deps: LinuxRuntimeHealthDeps,
): Effect.fn.Return<boolean> {
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
  Effect.result(deps.podmanApi.ping).pipe(
    Effect.flatMap((reachable) =>
      reachable._tag === "Failure" ? Effect.succeed(false) : currentRuntimeIsOwned(deps),
    ),
  );

const findAliveServicePids = Effect.fnUntraced(function* (
  deps: LinuxRuntimeHealthDeps,
  find:
    | ((spec: ReturnType<typeof buildPodmanServiceArgs>) => Effect.Effect<ReadonlyArray<number>>)
    | undefined,
): Effect.fn.Return<ReadonlyArray<number>> {
  if (find === undefined) return [];
  const pids = yield* find(buildPodmanServiceArgs(deps));
  const alive: number[] = [];
  for (const pid of pids) {
    if (yield* deps.serviceRunner.isAlive(pid)) alive.push(pid);
  }
  return alive;
});

export const stopDiscoveredRuntimeProcesses = Effect.fn("ProviderLando.stopDiscoveredRuntimeProcesses")(
  function* (deps: LinuxRuntimeHealthDeps): Effect.fn.Return<void> {
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
  },
);

const bestEffortRemove = (path: string): Effect.Effect<void> =>
  Effect.promise(() => rm(path, { force: true })).pipe(Effect.catch(() => Effect.void));

export const reapLegacyStaleRuntime = Effect.fn("ProviderLando.reapLegacyStaleRuntime")(function* (
  deps: LinuxRuntimeHealthDeps,
): Effect.fn.Return<void> {
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid !== undefined && (yield* deps.serviceRunner.isAlive(pid))) {
    const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(pid, buildPodmanServiceArgs(deps)) ??
      Effect.succeed(false);
    if (serviceProcess) yield* deps.serviceRunner.terminate(pid);
  }
  yield* bestEffortRemove(deps.socketPath);
  yield* bestEffortRemove(deps.pidPath);
  yield* bestEffortRemove(launchStatePath(deps.pidPath));
});
