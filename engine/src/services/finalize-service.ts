import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  type ServicePlan,
  containerDestinationRefusalMessage,
  parseContainerDestination,
} from "@lando/sdk/schema";
import { type DraftServicePlan, deterministicMetadata, sortRecord } from "./draft.ts";

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

  let appMount: ServicePlan["appMount"];
  if (draft.appMount !== undefined) {
    const parsed = parseContainerDestination(draft.appMount.target);
    if (!parsed.ok) return destinationError(draft.appMount.target, parsed.reason);
    appMount = { ...draft.appMount, target: parsed.value, realization: "passthrough" };
  }

  const mounts: Array<ServicePlan["mounts"][number]> = [];
  for (const mount of draft.mounts) {
    const parsed = parseContainerDestination(mount.target);
    if (!parsed.ok) return destinationError(mount.target, parsed.reason);
    mounts.push({ ...mount, target: parsed.value, realization: "passthrough" });
  }

  const storage: Array<ServicePlan["storage"][number]> = [];
  for (const entry of draft.storage) {
    const parsed = parseContainerDestination(entry.target);
    if (!parsed.ok) return destinationError(entry.target, parsed.reason);
    storage.push({ ...entry, target: parsed.value });
  }

  return {
    name: draft.name,
    type: draft.type,
    ...(draft.serviceTypeId === undefined ? {} : { serviceTypeId: draft.serviceTypeId }),
    provider: draft.provider,
    primary: draft.primary,
    ...(draft.artifact === undefined ? {} : { artifact: draft.artifact }),
    ...(draft.command === undefined ? {} : { command: draft.command }),
    ...(draft.entrypoint === undefined ? {} : { entrypoint: draft.entrypoint }),
    environment: sortRecord(draft.environment),
    ...(draft.connection !== undefined
      ? { connection: draft.connection }
      : draft.nonSqlCreds === undefined
        ? {}
        : { nonSqlCreds: draft.nonSqlCreds }),
    ...(draft.user === undefined ? {} : { user: draft.user }),
    ...(draft.workingDirectory === undefined ? {} : { workingDirectory: draft.workingDirectory }),
    ...(appMount === undefined ? {} : { appMount }),
    mounts,
    storage,
    endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
    routes: [],
    dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
    ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
    ...(draft.readiness === undefined ? {} : { readiness: draft.readiness }),
    ...(draft.certs === undefined ? {} : { certs: draft.certs }),
    hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
    metadata: deterministicMetadata,
    extensions: { ...coreExtension, ...(draft.extensions ?? {}) },
  };
};
