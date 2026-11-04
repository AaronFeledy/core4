import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  type ServicePlan,
  containerDestinationRefusalMessage,
  parseContainerDestination,
} from "@lando/sdk/schema";
import {
  type DraftServicePlan,
  deterministicMetadata,
  pickDraftOptionalServicePlanFields,
  sortRecord,
} from "./draft.ts";

const destinationError = (target: string, reason: "not-absolute" | "root"): ServiceFeatureError =>
  new ServiceFeatureError({
    message: containerDestinationRefusalMessage(reason, target),
    feature: "destination",
    remediation: "Correct the `destination` feature configuration in the Landofile, then re-run.",
  });

export const finalizeDraft = (draft: DraftServicePlan): ServicePlan | ServiceFeatureError => {
  const featureIds = draft.featureIds ?? [];
  const dataTrees = draft.storageOwnership ?? [];
  const coreExtension =
    draft.buildSteps.length === 0 && featureIds.length === 0 && dataTrees.length === 0
      ? {}
      : {
          "@lando/core/service-features": {
            ...(featureIds.length === 0 ? {} : { featureIds: [...featureIds] }),
            ...(dataTrees.length === 0 ? {} : { dataTrees: dataTrees.map((tree) => ({ ...tree })) }),
            ...(draft.buildSteps.length === 0
              ? {}
              : { buildSteps: draft.buildSteps.map((step) => ({ ...step })) }),
          },
        };

  const mounts: Array<ServicePlan["mounts"][number]> = [];
  if (draft.appMount !== undefined) {
    const parsed = parseContainerDestination(draft.appMount.target);
    if (!parsed.ok) return destinationError(draft.appMount.target, parsed.reason);
    mounts.push({
      ...draft.appMount,
      type: "bind",
      origin: "service",
      relativeTo: "app",
      role: "app",
      target: parsed.value,
      realization: "passthrough",
    });
  }

  for (const mount of draft.mounts) {
    const parsed = parseContainerDestination(mount.target);
    if (!parsed.ok) return destinationError(mount.target, parsed.reason);
    mounts.push(
      mount.type === "bind"
        ? { ...mount, origin: "service", target: parsed.value, realization: "passthrough" }
        : { ...mount, origin: "service", target: parsed.value },
    );
  }

  for (const entry of draft.storage) {
    const parsed = parseContainerDestination(entry.target);
    if (!parsed.ok) return destinationError(entry.target, parsed.reason);
    mounts.push({ ...entry, origin: "service", type: "volume", target: parsed.value });
  }

  return {
    name: draft.name,
    type: draft.type,
    provider: draft.provider,
    primary: draft.primary,
    ...pickDraftOptionalServicePlanFields(draft),
    environment: sortRecord(draft.environment),
    ...(draft.connection !== undefined
      ? { connection: draft.connection }
      : draft.nonSqlCreds === undefined
        ? {}
        : { nonSqlCreds: draft.nonSqlCreds }),
    mounts,
    endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
    routes: [],
    dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
    hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
    metadata: deterministicMetadata,
    extensions: { ...coreExtension, ...(draft.extensions ?? {}) },
  };
};
