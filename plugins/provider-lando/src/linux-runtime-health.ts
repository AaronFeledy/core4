import { rm } from "node:fs/promises";

import { Effect, Schema } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { LinuxRuntimeFilesystem, RuntimeGenerationStore } from "./linux-runtime-generation.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import { type PodmanServiceRunner, buildPodmanServiceArgs } from "./podman-service-runner.ts";
import { launchStatePath, readLaunchState, recordedLaunchMatchesSpec } from "./runtime-launch-state.ts";

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
  readonly privateRuntimeDir: string | undefined;
}

const TransitionContainers = Schema.fromJsonString(Schema.Array(Schema.Struct({ State: Schema.String })));

/** Running or paused containers on the service, or undefined when the inventory is unreadable. */
export const countRunningContainers = (api: PodmanApiClient): Effect.Effect<number | undefined> => {
  const request = api.request;
  if (request === undefined) return Effect.succeed(undefined);
  return request({ method: "GET", path: "/libpod/containers/json?all=true" }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Schema.decodeUnknownEffect(TransitionContainers)(response.body).pipe(
            Effect.map(
              (containers) =>
                containers.filter(
                  (container) => container.State === "running" || container.State === "paused",
                ).length,
            ),
          )
        : Effect.succeed(undefined),
    ),
    Effect.timeout("10 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  );
};

const verifyRuntimeDirectoryTransition = Effect.fn("ProviderLando.verifyRuntimeDirectoryTransition")(
  function* (deps: LinuxRuntimeHealthDeps): Effect.fn.Return<void, ProviderUnavailableError> {
    const state = yield* readLaunchState(deps.pidPath);
    const expected = deps.privateRuntimeDir;
    if (state?.env.XDG_RUNTIME_DIR === expected) return;
    const runningContainers = yield* countRunningContainers(deps.podmanApi);
    if (runningContainers !== 0)
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "setup",
          message:
            runningContainers === undefined
              ? "Lando could not read the previous runtime's container inventory. Lando keeps its data; it needs its containers stopped to move the runtime to its private directory."
              : `${runningContainers} containers from the previous Lando runtime are still running or paused. Lando keeps their data; it needs them stopped to move the runtime to its private directory.`,
          remediation: "Run `lando poweroff`, then rerun the command.",
          ...(runningContainers === undefined ? {} : { details: { runningContainers } }),
        }),
      );
  },
);

/**
 * A live owned daemon is about to be replaced. Its containers belong to its private runtime dir, so a
 * replacement that changes that dir needs the same admission whether or not its API still answers.
 */
export const verifyReplacedServiceTransition = Effect.fnUntraced(function* (
  deps: LinuxRuntimeHealthDeps,
): Effect.fn.Return<void, ProviderUnavailableError> {
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return;
  const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(pid, buildPodmanServiceArgs(deps)) ??
    Effect.succeed(false);
  if (serviceProcess) yield* verifyRuntimeDirectoryTransition(deps);
});

const currentRuntimeIsOwned = Effect.fnUntraced(function* (
  deps: LinuxRuntimeHealthDeps,
): Effect.fn.Return<boolean, ProviderUnavailableError> {
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return false;
  const spec = buildPodmanServiceArgs(deps);
  const serviceProcess = yield* deps.serviceRunner.isServiceProcess?.(pid, spec) ?? Effect.succeed(false);
  if (serviceProcess) yield* verifyRuntimeDirectoryTransition(deps);
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

export const linuxRuntimeHasOwnedService = Effect.fnUntraced(function* (
  deps: LinuxRuntimeHealthDeps,
): Effect.fn.Return<boolean> {
  if ((yield* Effect.result(deps.podmanApi.ping))._tag === "Failure") return false;
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return false;
  return yield* deps.serviceRunner.isServiceProcess?.(pid, buildPodmanServiceArgs(deps)) ??
    Effect.succeed(false);
});

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
