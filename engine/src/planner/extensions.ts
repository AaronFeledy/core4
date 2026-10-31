import type { BuildScript, BuildScriptStep, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import { serviceAppMount } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent, ServiceMountIntent, ServiceTypeResolution } from "@lando/sdk/services";
import { Predicate } from "effect";

import type { AppFeatureServiceDraft } from "../services/app-feature.ts";
import type { DraftServicePlan } from "../services/draft.ts";
import { sortRecord } from "../services/draft.ts";

export const SERVICE_FEATURES_EXTENSION_KEY = "@lando/core/service-features";
export const LOG_SOURCES_EXTENSION_KEY = "@lando/core/log-sources";

type NormalizedBuildStep = Exclude<BuildScriptStep, string>;

const normalizeBuildStep = (step: BuildScriptStep): NormalizedBuildStep =>
  typeof step === "string" ? { run: step } : step;

export const normalizeBuildScripts = (value: BuildScript | undefined): ReadonlyArray<NormalizedBuildStep> => {
  if (value === undefined) return [];
  if (typeof value === "string") return [{ run: value }];
  if ("run" in value) return [value];
  return value.map(normalizeBuildStep);
};

export const mergeComposeExtension = <S extends Pick<ServicePlan, "extensions">>(
  servicePlan: S,
  service: ServiceConfig,
): S => {
  const startInterval = service.healthcheck === false ? undefined : service.healthcheck?.startInterval;
  const hasDependencyRestart =
    service.dependsOn?.some((dependency) => dependency.restart !== undefined) ?? false;
  const authoredExtensions = Object.entries(service).filter(([key]) => key.startsWith("x-"));
  if (
    service.labels === undefined &&
    startInterval === undefined &&
    !hasDependencyRestart &&
    service.configs === undefined &&
    service.secrets === undefined &&
    service.profiles === undefined &&
    authoredExtensions.length === 0
  )
    return servicePlan;

  const composeExtension = servicePlan.extensions.compose;
  const compose = Predicate.isObject(composeExtension) ? { ...composeExtension } : {};
  if (service.labels !== undefined) {
    compose.labels = { ...(Predicate.isObject(compose.labels) ? compose.labels : {}), ...service.labels };
  }
  if (startInterval !== undefined) {
    compose.healthcheck = {
      ...(Predicate.isObject(compose.healthcheck) ? compose.healthcheck : {}),
      start_interval: startInterval,
    };
  }
  if (hasDependencyRestart) {
    const dependsOn = Predicate.isObject(compose.depends_on) ? { ...compose.depends_on } : {};
    for (const dependency of service.dependsOn ?? []) {
      if (dependency.restart === undefined) continue;
      const existing = dependsOn[dependency.service];
      dependsOn[dependency.service] = {
        ...(Predicate.isObject(existing) ? existing : {}),
        restart: dependency.restart,
      };
    }
    compose.depends_on = dependsOn;
  }
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
  return Predicate.isObject(extension) ? extension : undefined;
};

export const serviceFeatureBuildSteps = (extensions: ServicePlan["extensions"]): ServiceBuildStepIntent[] => {
  const buildSteps = serviceFeatureExtension(extensions)?.buildSteps;
  return Array.isArray(buildSteps) ? buildSteps.map((step) => ({ ...(step as ServiceBuildStepIntent) })) : [];
};

/** Data trees a service declared the planned user must own, across passes. */
const serviceFeatureDataTrees = (
  extensions: ServicePlan["extensions"],
): Array<{ target: string; seededOwners: ReadonlyArray<string> }> => {
  const trees = serviceFeatureExtension(extensions)?.dataTrees;
  return Array.isArray(trees)
    ? trees.map((tree) => {
        const entry = tree as { target: string; seededOwners: ReadonlyArray<string> };
        return { target: entry.target, seededOwners: [...entry.seededOwners] };
      })
    : [];
};

export const toAppFeatureDraft = (
  name: string,
  servicePlan: ServicePlan,
  serviceResolution: ServiceTypeResolution,
  featureIds: ReadonlyArray<string>,
): AppFeatureServiceDraft => {
  const appMount = serviceAppMount(servicePlan);
  return {
    name: servicePlan.name,
    serviceName: name,
    type: servicePlan.type,
    ...(servicePlan.serviceTypeId === undefined ? {} : { serviceTypeId: servicePlan.serviceTypeId }),
    serviceType: servicePlan.type,
    provider: servicePlan.provider,
    primary: servicePlan.primary,
    base: serviceResolution.base,
    framework: serviceResolution.normalizedConfig.framework,
    featureIds,
    normalizedConfig: serviceResolution.normalizedConfig,
    resolutionMetadata: serviceResolution.metadata,
    ...(servicePlan.artifact === undefined ? {} : { artifact: servicePlan.artifact }),
    ...(servicePlan.command === undefined ? {} : { command: servicePlan.command }),
    ...(servicePlan.entrypoint === undefined ? {} : { entrypoint: servicePlan.entrypoint }),
    environment: { ...servicePlan.environment },
    ...(servicePlan.connection === undefined ? {} : { connection: servicePlan.connection }),
    ...(servicePlan.nonSqlCreds === undefined ? {} : { nonSqlCreds: servicePlan.nonSqlCreds }),
    ...(servicePlan.sqlite === undefined ? {} : { sqlite: servicePlan.sqlite }),
    ...(servicePlan.user === undefined ? {} : { user: servicePlan.user }),
    ...(servicePlan.workingDirectory === undefined ? {} : { workingDirectory: servicePlan.workingDirectory }),
    ...(appMount === undefined
      ? {}
      : {
          appMount: {
            source: appMount.source,
            target: appMount.target,
            readOnly: appMount.readOnly,
            excludes: appMount.excludes ?? [],
            includes: appMount.includes ?? [],
          },
        }),
    mounts: servicePlan.mounts.flatMap((mount): ServiceMountIntent[] => {
      switch (mount.type) {
        case "bind": {
          const { realization: _realization, role, mountKey: _mountKey, ...intent } = mount;
          return role === "app" ? [] : [intent];
        }
        case "tmpfs":
          return [mount];
        case "volume":
          return [];
      }
    }),
    buildSteps: serviceFeatureBuildSteps(servicePlan.extensions),
    storage: servicePlan.mounts
      .filter((mount) => mount.type === "volume")
      .map((mount) => ({
        store: mount.store,
        target: mount.target,
        readOnly: mount.readOnly,
        ...(mount.subpath === undefined ? {} : { subpath: mount.subpath }),
      })),
    storageOwnership: serviceFeatureDataTrees(servicePlan.extensions),
    endpoints: servicePlan.endpoints.map((endpoint) => ({ ...endpoint })),
    dependsOn: servicePlan.dependsOn.map((dependency) => ({ ...dependency })),
    ...(servicePlan.healthcheck === undefined ? {} : { healthcheck: servicePlan.healthcheck }),
    ...(servicePlan.readiness === undefined ? {} : { readiness: servicePlan.readiness }),
    ...(servicePlan.readinessSource === undefined ? {} : { readinessSource: servicePlan.readinessSource }),
    ...(servicePlan.certs === undefined ? {} : { certs: servicePlan.certs }),
    hostAliases: servicePlan.hostAliases.map((alias) => ({ ...alias })),
    ...(serviceResolution.metadata === undefined ? {} : { provenance: serviceResolution.metadata }),
  };
};

export const servicePlanFromDraft = (
  draft: DraftServicePlan,
  routes: ServicePlan["routes"],
  metadata: ServicePlan["metadata"],
  extensions: ServicePlan["extensions"],
): ServicePlan => ({
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
  ...(draft.sqlite === undefined ? {} : { sqlite: draft.sqlite }),
  ...(draft.user === undefined ? {} : { user: draft.user }),
  ...(draft.workingDirectory === undefined ? {} : { workingDirectory: draft.workingDirectory }),
  mounts: [
    ...(draft.appMount === undefined
      ? []
      : [
          {
            ...draft.appMount,
            type: "bind" as const,
            origin: "service" as const,
            relativeTo: "app" as const,
            role: "app" as const,
            realization: "passthrough" as const,
          },
        ]),
    ...draft.mounts.map((mount) =>
      mount.type === "bind"
        ? { ...mount, origin: "service" as const, realization: "passthrough" as const }
        : { ...mount, origin: "service" as const },
    ),
    ...draft.storage.map((storage) => ({ ...storage, origin: "service" as const, type: "volume" as const })),
  ],
  endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
  routes: routes.map((route) => ({ ...route })),
  dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
  ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
  ...(draft.readiness === undefined ? {} : { readiness: draft.readiness }),
  ...(draft.readinessSource === undefined ? {} : { readinessSource: draft.readinessSource }),
  ...(draft.certs === undefined ? {} : { certs: draft.certs }),
  hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
  metadata,
  ...(draft.provenance === undefined ? {} : { provenance: draft.provenance }),
  extensions: servicePlanExtensionsFromDraft(draft, extensions),
});

const servicePlanExtensionsFromDraft = (
  draft: DraftServicePlan,
  extensions: ServicePlan["extensions"],
): ServicePlan["extensions"] => {
  const featureIds = draft.featureIds ?? [];
  const dataTrees = draft.storageOwnership ?? [];
  if (
    draft.buildSteps.length === 0 &&
    featureIds.length === 0 &&
    dataTrees.length === 0 &&
    serviceFeatureExtension(extensions)?.dataTrees === undefined
  )
    return extensions;
  return {
    ...extensions,
    [SERVICE_FEATURES_EXTENSION_KEY]: {
      ...serviceFeatureExtension(extensions),
      ...(featureIds.length === 0 ? {} : { featureIds: [...featureIds] }),
      dataTrees: dataTrees.map((tree) => ({ ...tree })),
      buildSteps: draft.buildSteps.map(({ user: authoredUser, ...step }) => {
        const user = authoredUser ?? draft.user;
        return { ...step, ...(user === undefined ? {} : { user }) };
      }),
    },
  };
};
