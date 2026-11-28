import { engineEndpointDisplay } from "@lando/sdk/engine-placement";
import type {
  AppPlan,
  AppliedAppPlan,
  CommandWarning,
  EngineIdentity,
  ServicePlan,
  VolumeCreationFact,
  VolumeMountPlan,
} from "@lando/sdk/schema";
import {
  DEPENDENCY_ENVIRONMENT_EXTENSION_KEY,
  DependencyEnvironmentJob,
  planAppIdentity,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { isDependencyEnvironmentStore } from "../planner/dependency-environments.ts";

export const RECREATED_DATA_VOLUME_CODE = "LANDO_DATA_VOLUME_RECREATED";

export type RecreatedVolumeBaseline = AppPlan & Pick<AppliedAppPlan, "engineIdentity">;

export interface RecreatedVolumeInput {
  readonly facts: readonly VolumeCreationFact[];
  readonly baseline: RecreatedVolumeBaseline;
  /** The identity the apply ran against; a different fingerprint means a different engine. */
  readonly engine?: EngineIdentity | undefined;
}

const mountingService = (
  baseline: RecreatedVolumeBaseline,
  volume: string,
): { readonly service: ServicePlan; readonly mount: VolumeMountPlan } | undefined => {
  for (const service of Object.values(baseline.services)) {
    for (const mount of service.mounts) {
      if (mount.type !== "volume" || mount.store !== volume) continue;
      // The job's own mount is managed too, not just its consumers' mounts.
      if (Schema.is(DependencyEnvironmentJob)(service.extensions[DEPENDENCY_ENVIRONMENT_EXTENSION_KEY]))
        continue;
      if (isDependencyEnvironmentStore(baseline, service, mount)) continue;
      return { service, mount };
    }
  }
  return undefined;
};

const remediation = (service: ServicePlan): string =>
  service.connection === undefined
    ? "Re-import its data if you still have it; Lando cannot recover a removed volume's previous contents."
    : `If a snapshot of its data exists, run \`lando db:snapshots\` and then \`lando db:restore <snapshot> --service ${service.name}\`. Otherwise re-import its data.`;

/**
 * Warns about each data volume the baseline recorded that apply created again. A cache or
 * dependency-environment store is managed state, and an adopted volume produces no creation fact,
 * so neither can claim the user's data was lost.
 */
export const recreatedVolumeWarnings = (input: RecreatedVolumeInput): readonly CommandWarning[] => {
  const root = planAppIdentity(input.baseline).appRoot;
  const recorded = input.baseline.engineIdentity;
  const replacedEngine =
    recorded !== undefined && input.engine !== undefined && recorded.fingerprint !== input.engine.fingerprint
      ? recorded
      : undefined;
  const warnings: CommandWarning[] = [];
  for (const fact of input.facts) {
    if (fact.ownerRoot !== root) continue;
    const store = input.baseline.stores.find(({ name, kind }) => name === fact.nativeName && kind === "data");
    if (store === undefined) continue;
    const mounted = mountingService(input.baseline, store.name);
    if (mounted === undefined) continue;
    const recordedEngine =
      replacedEngine === undefined ? undefined : engineEndpointDisplay(replacedEngine.endpoint);
    warnings.push({
      code: RECREATED_DATA_VOLUME_CODE,
      message: `The ${mounted.service.name} data volume ${store.name} was recreated without its previous contents.${
        recordedEngine !== undefined
          ? ` The container engine at ${recordedEngine} is not the one this app last ran on; resetting or reinstalling an engine removes its volumes.`
          : ""
      }`,
      remediation: remediation(mounted.service),
      context: {
        app: input.baseline.id,
        service: mounted.service.name,
        volume: store.name,
        target: mounted.mount.target,
        engineReplaced: recordedEngine === undefined ? "false" : "true",
        ...(recordedEngine === undefined ? {} : { recordedEngine }),
      },
    });
  }
  return warnings;
};
