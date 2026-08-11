import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent, ServiceTypeResolution } from "@lando/sdk/services";

import type { AppFeatureServiceDraft } from "../services/app-feature.ts";
import type { DraftServicePlan } from "../services/draft.ts";
import { sortRecord } from "../services/draft.ts";

export const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
export const LOG_SOURCES_EXTENSION_KEY = "@lando/core/log-sources";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeBuildScripts = (
  value: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
};

export const mergeComposeExtension = (servicePlan: ServicePlan, service: ServiceConfig): ServicePlan => {
  const startInterval = service.healthcheck?.startInterval;
  const hasDependencyRestart =
    service.dependsOn?.some((dependency) => dependency.restart !== undefined) ?? false;
  const authoredExtensions = Object.entries(service).filter(([key]) => key.startsWith("x-"));
  if (
    service.labels === undefined &&
    startInterval === undefined &&
    !hasDependencyRestart &&
    service.networks === undefined &&
    service.configs === undefined &&
    service.secrets === undefined &&
    service.profiles === undefined &&
    authoredExtensions.length === 0
  )
    return servicePlan;

  const composeExtension = servicePlan.extensions.compose;
  const compose = isRecord(composeExtension) ? { ...composeExtension } : {};
  if (service.labels !== undefined) {
    compose.labels = { ...(isRecord(compose.labels) ? compose.labels : {}), ...service.labels };
  }
  if (startInterval !== undefined) {
    compose.healthcheck = {
      ...(isRecord(compose.healthcheck) ? compose.healthcheck : {}),
      start_interval: startInterval,
    };
  }
  if (hasDependencyRestart) {
    const dependsOn = isRecord(compose.depends_on) ? { ...compose.depends_on } : {};
    for (const dependency of service.dependsOn ?? []) {
      if (dependency.restart === undefined) continue;
      const existing = dependsOn[dependency.service];
      dependsOn[dependency.service] = {
        ...(isRecord(existing) ? existing : {}),
        restart: dependency.restart,
      };
    }
    compose.depends_on = dependsOn;
  }
  if (service.networks !== undefined) compose.networks = service.networks;
  if (service.configs !== undefined) compose.configs = service.configs;
  if (service.secrets !== undefined) compose.secrets = service.secrets;
  if (service.profiles !== undefined) compose.profiles = service.profiles;
  for (const [key, value] of authoredExtensions) compose[key] = value;

  return {
    ...servicePlan,
    extensions: { ...servicePlan.extensions, compose },
  };
};

export const serviceFeatureExtension = (
  extensions: ServicePlan["extensions"],
): Record<string, unknown> | undefined => {
  const extension = extensions[SERVICE_FEATURES_EXTENSION_KEY];
  return isRecord(extension) ? extension : undefined;
};

export const serviceFeatureBuildSteps = (extensions: ServicePlan["extensions"]): ServiceBuildStepIntent[] => {
  const buildSteps = serviceFeatureExtension(extensions)?.buildSteps;
  return Array.isArray(buildSteps) ? buildSteps.map((step) => ({ ...(step as ServiceBuildStepIntent) })) : [];
};

export const toAppFeatureDraft = (
  name: string,
  servicePlan: ServicePlan,
  serviceResolution: ServiceTypeResolution,
  baseDefaultIds: ReadonlyArray<string>,
): AppFeatureServiceDraft => ({
  name: servicePlan.name,
  serviceName: name,
  type: servicePlan.type,
  serviceType: servicePlan.type,
  provider: servicePlan.provider,
  primary: servicePlan.primary,
  base: serviceResolution.base,
  framework: serviceResolution.normalizedConfig.framework,
  featureIds: [...baseDefaultIds, ...serviceResolution.features.map((feature) => feature.id)],
  normalizedConfig: serviceResolution.normalizedConfig,
  ...(servicePlan.artifact === undefined ? {} : { artifact: servicePlan.artifact }),
  ...(servicePlan.command === undefined ? {} : { command: servicePlan.command }),
  ...(servicePlan.entrypoint === undefined ? {} : { entrypoint: servicePlan.entrypoint }),
  environment: { ...servicePlan.environment },
  ...(servicePlan.user === undefined ? {} : { user: servicePlan.user }),
  ...(servicePlan.workingDirectory === undefined ? {} : { workingDirectory: servicePlan.workingDirectory }),
  ...(servicePlan.appMount === undefined
    ? {}
    : {
        appMount: {
          source: servicePlan.appMount.source,
          target: servicePlan.appMount.target,
          readOnly: servicePlan.appMount.readOnly,
          excludes: servicePlan.appMount.excludes,
          includes: servicePlan.appMount.includes,
        },
      }),
  mounts: servicePlan.mounts.map((mount) => {
    const { realization: _realization, ...intent } = mount;
    return intent;
  }),
  buildSteps: serviceFeatureBuildSteps(servicePlan.extensions),
  storage: servicePlan.storage.map((storage) => ({ ...storage })),
  endpoints: servicePlan.endpoints.map((endpoint) => ({ ...endpoint })),
  dependsOn: servicePlan.dependsOn.map((dependency) => ({ ...dependency })),
  ...(servicePlan.healthcheck === undefined ? {} : { healthcheck: servicePlan.healthcheck }),
  ...(servicePlan.certs === undefined ? {} : { certs: servicePlan.certs }),
  hostAliases: servicePlan.hostAliases.map((alias) => ({ ...alias })),
});

export const servicePlanFromDraft = (
  draft: DraftServicePlan,
  routes: ServicePlan["routes"],
  metadata: ServicePlan["metadata"],
  extensions: ServicePlan["extensions"],
): ServicePlan => ({
  name: draft.name,
  type: draft.type,
  provider: draft.provider,
  primary: draft.primary,
  ...(draft.artifact === undefined ? {} : { artifact: draft.artifact }),
  ...(draft.command === undefined ? {} : { command: draft.command }),
  ...(draft.entrypoint === undefined ? {} : { entrypoint: draft.entrypoint }),
  environment: sortRecord(draft.environment),
  ...(draft.user === undefined ? {} : { user: draft.user }),
  ...(draft.workingDirectory === undefined ? {} : { workingDirectory: draft.workingDirectory }),
  ...(draft.appMount === undefined ? {} : { appMount: { ...draft.appMount, realization: "passthrough" } }),
  mounts: draft.mounts.map((mount) => ({ ...mount, realization: "passthrough" })),
  storage: draft.storage.map((storage) => ({ ...storage })),
  endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
  routes: routes.map((route) => ({ ...route })),
  dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
  ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
  ...(draft.certs === undefined ? {} : { certs: draft.certs }),
  hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
  metadata,
  extensions: servicePlanExtensionsFromDraft(draft, extensions),
});

const servicePlanExtensionsFromDraft = (
  draft: DraftServicePlan,
  extensions: ServicePlan["extensions"],
): ServicePlan["extensions"] => {
  const featureIds = draft.featureIds ?? [];
  if (draft.buildSteps.length === 0 && featureIds.length === 0) return extensions;
  return {
    ...extensions,
    [SERVICE_FEATURES_EXTENSION_KEY]: {
      ...serviceFeatureExtension(extensions),
      ...(featureIds.length === 0 ? {} : { featureIds: [...featureIds] }),
      buildSteps: draft.buildSteps.map((step) => ({ ...step })),
    },
  };
};
