import { isDeepStrictEqual } from "node:util";

import { Effect } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, type FileSyncSessionSpec, sameAppMountTarget } from "@lando/sdk/schema";

import {
  type MutagenProcessClient,
  type PreparedWindowsMutagenProcessClientOptions,
  makePreparedWindowsMutagenProcessClient,
} from "./mutagen-process-client.ts";

/** Structural shape returned by provider-lando's prepareWindowsSyncTargets. */
export interface PreparedWindowsMutagenTargets {
  readonly targets: ReadonlyArray<{
    readonly session: FileSyncSessionSpec;
    readonly endpoint: {
      readonly containerId: string;
      readonly volumeName: string;
      readonly path: string;
    };
  }>;
}

export interface PreparedWindowsMutagenAppClientOptions
  extends Omit<PreparedWindowsMutagenProcessClientOptions, "resolveTarget"> {
  readonly plan: AppPlan;
  readonly preparedTargets: PreparedWindowsMutagenTargets;
}

const invalidTargets = (message: string) =>
  new FileSyncStartError({
    engineId: "mutagen",
    message,
    remediation:
      "Prepare and verify the full Windows sync target set with the selected provider before starting file sync.",
  });

/**
 * Explicit composition seam for a fully prepared provider target set.
 * The default bundled engine never calls this factory; activation needs
 * ordered app lifecycle, rollback, and destroy cleanup first.
 */
export const makePreparedWindowsMutagenAppClient = (
  options: PreparedWindowsMutagenAppClientOptions,
): Effect.Effect<MutagenProcessClient, FileSyncStartError> => {
  const { plan, preparedTargets, ...clientOptions } = options;
  const planned = plan.fileSync;
  const targets = preparedTargets.targets;
  const expectedMounts = new Set<string>();
  for (const [serviceName, service] of Object.entries(plan.services)) {
    if (service.appMount?.realization === "accelerated") expectedMounts.add(`${serviceName}/app-mount`);
    for (const [index, mount] of service.mounts.entries()) {
      if (
        mount.type === "bind" &&
        mount.realization === "accelerated" &&
        !sameAppMountTarget(service.appMount, mount)
      ) {
        expectedMounts.add(`${serviceName}/mount-${index}`);
      }
    }
  }
  const plannedKeys = planned.map(({ session }) => `${session.service}/${session.mountKey}`);
  if (
    String(plan.provider) !== "lando" ||
    planned.length === 0 ||
    expectedMounts.size !== planned.length ||
    new Set(plannedKeys).size !== planned.length ||
    plannedKeys.some((key) => !expectedMounts.has(key)) ||
    planned.length !== targets.length ||
    planned.some((entry) => entry.engineId !== "mutagen") ||
    targets.some(
      ({ session, endpoint }, index) =>
        !isDeepStrictEqual(session, planned[index]?.session) ||
        session.target._tag !== "volume" ||
        endpoint.volumeName !== session.target.name ||
        endpoint.path !== "/sync" ||
        endpoint.containerId.length === 0,
    )
  ) {
    return Effect.fail(
      invalidTargets("The prepared Windows sync targets do not match the complete app plan."),
    );
  }

  return makePreparedWindowsMutagenProcessClient({
    ...clientOptions,
    resolveTarget: (spec) => {
      const matching = targets.filter(({ session }) => isDeepStrictEqual(session, spec));
      const endpoint = matching[0]?.endpoint;
      return matching.length === 1 && endpoint !== undefined
        ? Effect.succeed({ containerId: endpoint.containerId, path: endpoint.path })
        : Effect.fail(
            invalidTargets("The requested Mutagen session has no unique verified provider target."),
          );
    },
  });
};
