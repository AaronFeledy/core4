import { AppFeatureCloneError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
  imageLacksInstallShell,
} from "@lando/sdk/schema";
import { Predicate } from "effect";

import type { RecordedClonedService } from "../services/app-feature-types.ts";
import type { PlannedServiceDraft } from "./service-types.ts";

export { imageLacksInstallShell };

const COMPOSE_PUBLISH_KEYS = ["ports", "expose", "healthcheck"] as const;

/** Provenance key stamped onto every service materialized by `addClonedService`. */
export const CLONED_SERVICE_PROVENANCE_KEY = "clonedBy" as const;

export interface ClonedServiceStamp {
  readonly feature: string;
  readonly from: string;
}

export const clonedServiceStamp = (
  service: Pick<ServicePlan, "provenance">,
): ClonedServiceStamp | undefined => {
  const value = service.provenance?.[CLONED_SERVICE_PROVENANCE_KEY];
  if (typeof value !== "object" || value === null) return undefined;
  const feature = Reflect.get(value, "feature");
  const from = Reflect.get(value, "from");
  if (typeof feature !== "string" || typeof from !== "string") return undefined;
  return { feature, from };
};

/** Feature-created clones present in applied state but absent from the desired plan. */
export const staleClonedServices = (applied: AppPlan, desired: AppPlan): ReadonlyArray<ServicePlan> =>
  Object.values(applied.services).filter(
    (service) => clonedServiceStamp(service) !== undefined && desired.services[service.name] === undefined,
  );

const parentImage = (draft: PlannedServiceDraft["draft"]): string | undefined => {
  const image = draft.normalizedConfig.image;
  if (typeof image === "string" && image.length > 0) return image;
  const artifact = draft.artifact;
  if (artifact !== undefined && "kind" in artifact && artifact.kind === "ref") return artifact.ref;
  return undefined;
};

const omitConfigKeys = (config: ServiceConfig, keys: ReadonlyArray<string> | undefined): ServiceConfig => {
  if (keys === undefined || keys.length === 0) return { ...config };
  const omit = new Set(keys);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !omit.has(key))) as ServiceConfig;
};

const stripComposePublish = (extensions: ServicePlan["extensions"]): ServicePlan["extensions"] => {
  const composeExtension = extensions.compose;
  if (!Predicate.isObject(composeExtension)) return { ...extensions };
  const compose = { ...composeExtension };
  for (const key of COMPOSE_PUBLISH_KEYS) delete compose[key];
  return { ...extensions, compose };
};

const clonePlannedDraft = (
  parent: PlannedServiceDraft,
  request: RecordedClonedService,
): PlannedServiceDraft => {
  const name = ServiceName.make(request.name);
  const extraEnv = request.extraEnv ?? {};
  const extraBuildSteps = request.extraBuildSteps ?? [];
  const parentDraft = parent.draft;
  const {
    healthcheck: _healthcheck,
    readiness: _readiness,
    readinessSource: _readinessSource,
    listenerAuthority: _listenerAuthority,
    certs: _certs,
    ...rest
  } = parentDraft;
  return {
    name,
    authoredStorage: parent.authoredStorage,
    hostnames: [],
    authoredArtifact: parent.authoredArtifact,
    authored: parent.authored,
    homeIntent: parent.homeIntent,
    logSources: parent.logSources,
    routes: undefined,
    extensions: stripComposePublish(parent.extensions ?? {}),
    draft: {
      ...rest,
      name,
      serviceName: request.name,
      primary: false,
      command: request.command,
      ...(request.user === undefined ? {} : { user: request.user }),
      environment: { ...parentDraft.environment, ...extraEnv },
      mounts: parentDraft.mounts.map((mount) => ({ ...mount })),
      buildSteps: [...parentDraft.buildSteps.map((step) => ({ ...step })), ...extraBuildSteps],
      storage: parentDraft.storage.map((entry) => ({ ...entry })),
      ...(parentDraft.storageOwnership === undefined
        ? {}
        : {
            storageOwnership: parentDraft.storageOwnership.map((tree) => ({
              target: tree.target,
              seededOwners: [...tree.seededOwners],
            })),
          }),
      endpoints: [],
      dependsOn: [
        ...parentDraft.dependsOn.map((dependency) => ({ ...dependency })),
        { service: ServiceName.make(parent.name), condition: "service_started", required: true },
      ],
      hostAliases: parentDraft.hostAliases.map((alias) => ({ ...alias })),
      normalizedConfig: {
        ...omitConfigKeys(parentDraft.normalizedConfig, request.omitConfigKeys),
        ...(request.user === undefined ? {} : { user: request.user }),
      },
      provenance: {
        ...(parentDraft.provenance ?? {}),
        [CLONED_SERVICE_PROVENANCE_KEY]: { feature: request.feature, from: request.from },
      },
      ...(parentDraft.appMount === undefined ? {} : { appMount: { ...parentDraft.appMount } }),
    },
  };
};

export interface MaterializedClones {
  readonly drafts: ReadonlyArray<PlannedServiceDraft>;
  readonly parentNetworks: ReadonlyMap<string, NonNullable<ServiceConfig["networks"]> | undefined>;
}

export const materializeClonedServices = (input: {
  readonly plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>;
  readonly clones: ReadonlyArray<RecordedClonedService>;
  readonly parentNetworksByName: ReadonlyMap<string, ServiceConfig["networks"]>;
}): MaterializedClones => {
  if (input.clones.length === 0) return { drafts: [], parentNetworks: new Map() };
  const byName = new Map(input.plannedServiceDrafts.map((entry) => [entry.name, entry]));
  const seenCloneNames = new Set<string>();
  const drafts: PlannedServiceDraft[] = [];
  const parentNetworks = new Map<string, ServiceConfig["networks"]>();
  for (const request of input.clones) {
    if (seenCloneNames.has(request.name) || byName.has(request.name)) {
      throw new AppFeatureCloneError({
        feature: request.feature,
        service: request.name,
        from: request.from,
        reason: byName.has(request.name) ? "name-collision" : "duplicate-clone",
        message: byName.has(request.name)
          ? `Cannot clone service ${request.from} to ${request.name}: that name is already a service.`
          : `Cannot clone service ${request.from} to ${request.name}: that clone name was already requested.`,
        remediation: `Choose a free service name for the clone, or remove the extra ${request.name} service.`,
      });
    }
    const parent = byName.get(request.from);
    if (parent === undefined) {
      throw new AppFeatureCloneError({
        feature: request.feature,
        service: request.name,
        from: request.from,
        reason: "missing-parent",
        message: `Cannot clone service ${request.from} to ${request.name}: ${request.from} is not a resolved service.`,
        remediation: `Clone an existing service name, not ${request.from}.`,
      });
    }
    const image = parentImage(parent.draft);
    if ((request.extraBuildSteps?.length ?? 0) > 0 && imageLacksInstallShell(image)) {
      throw new AppFeatureCloneError({
        feature: request.feature,
        service: request.name,
        from: request.from,
        reason: "unsupported-image",
        ...(image === undefined ? {} : { image }),
        message: `Cannot add build steps to cloned service ${request.name}: parent image ${image ?? "(none)"} has no shell.`,
        remediation: `Use an image that includes a shell, not distroless or scratch, or omit extra build steps on the clone of ${request.from}.`,
      });
    }
    seenCloneNames.add(request.name);
    const cloned = clonePlannedDraft(parent, request);
    drafts.push(cloned);
    parentNetworks.set(request.name, input.parentNetworksByName.get(request.from));
  }
  return { drafts, parentNetworks };
};
