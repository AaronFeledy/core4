import { readFile } from "node:fs/promises";

import {
  type ManagedRuntimeServicePaths,
  buildManagedRuntimeServiceSpec,
  terminateOwnedRuntimeService,
} from "@lando/core/managed-runtime-service";
import { Effect } from "effect";

import type { PodmanApiClient } from "./capabilities.ts";
import type { PodmanServiceRunner, PodmanServiceSpec } from "./podman-service-runner.ts";

export interface RuntimeServiceStatus {
  readonly running: boolean;
  readonly socketReachable: boolean;
  readonly pid?: number;
  readonly ownedServiceProcess: boolean;
  readonly orphanPids?: ReadonlyArray<number>;
}

export interface RuntimeStatusDeps {
  readonly podmanApi?: PodmanApiClient;
  readonly serviceRunner: PodmanServiceRunner;
  readonly spec: PodmanServiceSpec;
  readonly pidPath: string;
}

const readRecordedPid = (pidPath: string): Effect.Effect<number | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const raw = (await readFile(pidPath, "utf8")).trim();
      if (!/^\d+$/u.test(raw)) return undefined;
      return Number(raw);
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll((pid) => Effect.succeed(pid)));

const safeBoolean = (effect: Effect.Effect<boolean, unknown>): Effect.Effect<boolean> =>
  effect.pipe(Effect.catchAllCause(() => Effect.succeed(false)));

const socketReachable = (podmanApi?: PodmanApiClient): Effect.Effect<boolean> => {
  if (podmanApi === undefined) return Effect.succeed(false);
  return podmanApi.info.pipe(
    Effect.as(true),
    Effect.catchAllCause(() => Effect.succeed(false)),
  );
};

const findAliveOrphanPids = (
  deps: RuntimeStatusDeps,
  recordedOwnedPid: number | undefined,
): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    const findMatchingServicePids = deps.serviceRunner.findMatchingServicePids;
    if (findMatchingServicePids === undefined) return [];

    const matchingPids = yield* findMatchingServicePids(deps.spec).pipe(
      Effect.catchAllCause(() => Effect.succeed([] as ReadonlyArray<number>)),
    );
    const orphanPids: number[] = [];
    for (const pid of matchingPids) {
      if (pid === recordedOwnedPid) continue;
      const alive = yield* safeBoolean(deps.serviceRunner.isAlive(pid));
      if (alive) orphanPids.push(pid);
    }
    return orphanPids;
  });

export const probeRuntimeServiceStatus = (deps: RuntimeStatusDeps): Effect.Effect<RuntimeServiceStatus> =>
  Effect.gen(function* () {
    const reachable = yield* socketReachable(deps.podmanApi);
    const recordedPid = yield* readRecordedPid(deps.pidPath);
    const alive =
      recordedPid === undefined ? false : yield* safeBoolean(deps.serviceRunner.isAlive(recordedPid));
    const pid = alive ? recordedPid : undefined;
    const ownedServiceProcess =
      pid !== undefined && deps.serviceRunner.isServiceProcess !== undefined
        ? yield* safeBoolean(deps.serviceRunner.isServiceProcess(pid, deps.spec))
        : false;
    const orphanPids = yield* findAliveOrphanPids(deps, ownedServiceProcess ? pid : undefined);

    return {
      running: reachable,
      socketReachable: reachable,
      ownedServiceProcess,
      ...(pid === undefined ? {} : { pid }),
      ...(orphanPids.length === 0 ? {} : { orphanPids }),
    };
  }).pipe(
    Effect.catchAllCause(() =>
      Effect.succeed({ running: false, socketReachable: false, ownedServiceProcess: false }),
    ),
  );

export const teardownRuntimeService = (params: {
  readonly paths: ManagedRuntimeServicePaths;
}): Effect.Effect<{ readonly terminated: boolean; readonly pid?: number }> =>
  terminateOwnedRuntimeService(buildManagedRuntimeServiceSpec(params.paths));
