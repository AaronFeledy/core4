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
      readonly permissions?: {
        readonly owner: string;
        readonly group: string;
        readonly defaultFileMode: string;
        readonly defaultDirectoryMode: string;
      };
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
 * Bind the complete verified managed Windows target set to a durable
 * Mutagen process client after provider preparation.
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
        endpoint.containerId.length === 0 ||
        endpoint.permissions === undefined ||
        !/^\d+$/u.test(endpoint.permissions.owner) ||
        !/^\d+$/u.test(endpoint.permissions.group) ||
        !/^0[0-7]{3}$/u.test(endpoint.permissions.defaultFileMode) ||
        !/^0[0-7]{3}$/u.test(endpoint.permissions.defaultDirectoryMode),
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
        ? Effect.succeed({
            containerId: endpoint.containerId,
            path: endpoint.path,
            ...(endpoint.permissions === undefined ? {} : { permissions: endpoint.permissions }),
          })
        : Effect.fail(
            invalidTargets("The requested Mutagen session has no unique verified provider target."),
          );
    },
  });
};
