import { AppFeatureCloneError } from "@lando/sdk/errors";
import {
  CLONED_SERVICE_PROVENANCE_KEY,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Effect, Predicate } from "effect";

import type { RecordedClonedService } from "../services/app-feature-types.ts";
import { appFeatureError } from "./app-feature-error.ts";
import { type DnsNameClaim, dnsNameClaims } from "./dns-name-validation.ts";
import type { PlannedServiceDraft, ResolvedService } from "./service-types.ts";

const COMPOSE_PUBLISH_KEYS = ["ports", "expose", "healthcheck"] as const;

/**
 * Normalized-config inputs finalization can turn into a listener, host
 * publication, route, hostname, alias, probe, or certificate. A clone is a
 * companion of its parent, not a second copy of its network presence, so these
 * never reach the clone. Engine-owned: features do not have to remember them.
 */
const CLONE_OMITTED_CONFIG_KEYS = [
  "certs",
  "endpoints",
  "expose",
  "healthcheck",
  "hostnames",
  "networks",
  "ports",
  "readiness",
  "routes",
] as const;

/** True when the image reference is scratch or distroless and cannot run install steps. */
const imageLacksInstallShell = (image: string | undefined): boolean => {
  if (image === undefined || image.length === 0) return false;
  const withoutDigest = image.toLowerCase().split("@")[0] ?? image.toLowerCase();
  if (withoutDigest === "scratch" || withoutDigest.startsWith("scratch:")) return true;
  if (withoutDigest.endsWith("/scratch") || withoutDigest.includes("/scratch:")) return true;
  return withoutDigest.includes("distroless");
};

const parentImage = (draft: PlannedServiceDraft["draft"]): string | undefined => {
  const image = draft.normalizedConfig.image;
  if (typeof image === "string" && image.length > 0) return image;
  const artifact = draft.artifact;
  if (artifact !== undefined && "kind" in artifact && artifact.kind === "ref") return artifact.ref;
  return undefined;
};

/** Remove the engine-owned clone keys plus the feature's own config keys. */
const cloneConfig = (
  config: ServiceConfig,
  requestKeys: ReadonlyArray<string> | undefined,
): ServiceConfig => {
  const omit = new Set<string>([...CLONE_OMITTED_CONFIG_KEYS, ...(requestKeys ?? [])]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !omit.has(key))) as ServiceConfig;
};

const stripComposePublish = (extensions: ServicePlan["extensions"]): ServicePlan["extensions"] => {
  const composeExtension = extensions.compose;
  if (!Predicate.isObject(composeExtension)) return { ...extensions };
  const compose = { ...composeExtension };
  for (const key of COMPOSE_PUBLISH_KEYS) delete compose[key];
  return { ...extensions, compose };
};

/**
 * The clone's container process is exactly its requested command. An entrypoint
 * with no command replaces the image ENTRYPOINT and suppresses its CMD; as a
 * command it would instead be appended to the parent's entrypoint.
 */
const cloneEntrypoint = (command: RecordedClonedService["command"]): ReadonlyArray<string> =>
  typeof command === "string" ? ["sh", "-c", command] : [...command];

/** Inherited build steps, minus the parent's app phase, pinned when the clone runs as another user. */
const inheritedBuildSteps = (
  parentDraft: PlannedServiceDraft["draft"],
  request: RecordedClonedService,
): PlannedServiceDraft["draft"]["buildSteps"] =>
  parentDraft.buildSteps
    .filter((step) => step.phase !== "app")
    .map((step) => {
      if (request.user === undefined) return { ...step };
      // The parent's unpinned steps run as the parent's user or the image
      // default, which the planner cannot observe. Root is the default for
      // images whose unpinned steps install anything, so pin them here rather
      // than letting a clone user override silently change the parent's build.
      return { ...step, user: step.user ?? parentDraft.user ?? "root" };
    });

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
    storageOwnership: _storageOwnership,
    connection: _connection,
    nonSqlCreds: _nonSqlCreds,
    sqlite: _sqlite,
    entrypoint: _entrypoint,
    command: _command,
    ...rest
  } = parentDraft;
  return {
    name,
    authoredStorage: parent.authoredStorage,
    hostnames: [],
    authoredArtifact: parent.authoredArtifact,
    pullPolicy: parent.pullPolicy,
    authored: parent.authored,
    // A different principal cannot share the parent's home store, and preparing
    // a new one would insert a build step before the inherited layers.
    homeIntent:
      request.user === undefined
        ? parent.homeIntent
        : { serviceType: parent.homeIntent.serviceType, home: false },
    logSources: parent.logSources,
    routes: undefined,
    extensions: stripComposePublish(parent.extensions ?? {}),
    // The clone shares the parent's service-scoped stores: same files, same
    // dependencies. A user override drops home persistence, so it mounts no
    // home store here or in finalize.
    storeOwner: parent.name,
    draft: {
      ...rest,
      name,
      serviceName: request.name,
      primary: false,
      entrypoint: cloneEntrypoint(request.command),
      // A clone may inherit an image HEALTHCHECK aimed at the parent's server,
      // so disable it explicitly instead of leaving it absent.
      healthcheck: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 5 },
      ...(request.user === undefined ? {} : { user: request.user }),
      environment: { ...parentDraft.environment, ...extraEnv },
      mounts: parentDraft.mounts.map((mount) => ({ ...mount })),
      buildSteps: [
        ...inheritedBuildSteps(parentDraft, request),
        ...extraBuildSteps.map((step) => ({ ...step })),
      ],
      storage: parentDraft.storage.map((entry) => ({ ...entry })),
      endpoints: [],
      dependsOn: [
        ...parentDraft.dependsOn.map((dependency) => ({ ...dependency })),
        { service: ServiceName.make(parent.name), condition: "service_started", required: true },
      ],
      hostAliases: parentDraft.hostAliases.map((alias) => ({ ...alias })),
      normalizedConfig: {
        ...cloneConfig(parentDraft.normalizedConfig, request.omitConfigKeys),
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

/** Drop the parent's authored aliases while keeping its network membership. */
const networksWithoutAliases = (
  networks: ServiceConfig["networks"] | undefined,
): ServiceConfig["networks"] | undefined =>
  networks === undefined
    ? undefined
    : (Object.fromEntries(
        Object.entries(networks).map(([key, attachment]) => {
          const { aliases: _aliases, ...membership } = attachment;
          return [key, membership];
        }),
      ) as ServiceConfig["networks"]);

const claimKind = (claim: DnsNameClaim): string => {
  // The claim kind is the service field that holds the name, never a segment
  // value: a service may itself be named hostnames or networks.
  const field = claim.path[2];
  if (field === "hostnames") return "hostname";
  if (field === "networks") return "network alias";
  return "service name";
};

export interface MaterializedClones {
  readonly drafts: ReadonlyArray<PlannedServiceDraft>;
  readonly parentNetworks: ReadonlyMap<string, ServiceConfig["networks"] | undefined>;
}

export const materializeClonedServices = (input: {
  readonly plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>;
  readonly clones: ReadonlyArray<RecordedClonedService>;
  readonly parentNetworksByName: ReadonlyMap<string, ServiceConfig["networks"]>;
  /** App slug used to derive each clone's internal DNS name. */
  readonly appSlug?: string | undefined;
  /** Every DNS name the app already claims, for case-insensitive clone-name rejection. */
  readonly reservedDnsNames?: ReadonlyArray<DnsNameClaim>;
}): MaterializedClones => {
  if (input.clones.length === 0) return { drafts: [], parentNetworks: new Map() };
  const byName = new Map(input.plannedServiceDrafts.map((entry) => [entry.name, entry]));
  const reserved = new Map<string, DnsNameClaim>();
  const reserve = (claim: DnsNameClaim) => {
    const key = claim.name.toLowerCase();
    if (!reserved.has(key)) reserved.set(key, claim);
  };
  for (const claim of input.reservedDnsNames ?? []) reserve(claim);
  const seenCloneNames = new Set<string>();
  const drafts: PlannedServiceDraft[] = [];
  const parentNetworks = new Map<string, ServiceConfig["networks"] | undefined>();
  for (const request of input.clones) {
    const derived = input.appSlug === undefined ? undefined : `${request.name}.${input.appSlug}.internal`;
    if (seenCloneNames.has(request.name.toLowerCase()) || byName.has(request.name)) {
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
    const collision = [request.name, ...(derived === undefined ? [] : [derived])]
      .map((name) => reserved.get(name.toLowerCase()))
      .find((claim) => claim !== undefined);
    if (collision !== undefined) {
      throw new AppFeatureCloneError({
        feature: request.feature,
        service: request.name,
        from: request.from,
        reason: "name-collision",
        message: `Cannot clone service ${request.from} to ${request.name}: ${collision.name} is already the ${claimKind(collision)} of service ${collision.service}.`,
        remediation: `Choose a clone name other than ${collision.name}; a service key, hostname, and network alias must each identify exactly one service.`,
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
    seenCloneNames.add(request.name.toLowerCase());
    reserve({
      network: "default",
      name: request.name,
      service: request.name,
      path: ["services", request.name],
      concrete: true,
      authored: true,
    });
    if (derived !== undefined)
      reserve({
        network: "default",
        name: derived,
        service: request.name,
        path: ["services", request.name],
        concrete: true,
        authored: false,
      });
    drafts.push(clonePlannedDraft(parent, request));
    parentNetworks.set(request.name, networksWithoutAliases(input.parentNetworksByName.get(request.from)));
  }
  return { drafts, parentNetworks };
};

export const materializeClonedServiceDrafts = Effect.fnUntraced(function* (
  plannedServiceDrafts: ReadonlyArray<PlannedServiceDraft>,
  {
    clones,
    resolvedServices,
    appRoot,
    appSlug,
  }: {
    readonly clones: ReadonlyArray<RecordedClonedService>;
    readonly resolvedServices: ReadonlyArray<Pick<ResolvedService, "name" | "service">>;
    readonly appRoot: string;
    readonly appSlug: string;
  },
) {
  const cloned = yield* Effect.try({
    try: () =>
      materializeClonedServices({
        plannedServiceDrafts,
        clones,
        parentNetworksByName: new Map(resolvedServices.map((entry) => [entry.name, entry.service.networks])),
        appSlug,
        reservedDnsNames: dnsNameClaims({
          services: Object.fromEntries(resolvedServices.map((entry) => [entry.name, entry.service])),
          appSlug,
        }),
      }),
    catch: (error) => appFeatureError(appRoot, error),
  });
  const plannedWithClones =
    cloned.drafts.length === 0 ? plannedServiceDrafts : [...plannedServiceDrafts, ...cloned.drafts];
  return { cloned, plannedWithClones };
});

export const networkServicesWithClones = (
  resolvedServices: ReadonlyArray<Pick<ResolvedService, "name" | "service">>,
  cloned: MaterializedClones,
  serviceNames: ReadonlyArray<string>,
): Readonly<Record<string, Pick<ServiceConfig, "networks">>> =>
  Object.fromEntries([
    ...resolvedServices
      .filter(({ name }) => serviceNames.includes(name))
      .map(({ name, service }) => [name, service] as const),
    ...cloned.drafts
      .filter((draft) => serviceNames.includes(draft.name))
      .map((draft) => [draft.name, { networks: cloned.parentNetworks.get(draft.name) }] as const),
  ]);
