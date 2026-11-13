import { AppFeatureCloneError } from "@lando/sdk/errors";
import {
  CLONED_SERVICE_PROVENANCE_KEY,
  type ProviderCapabilities,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Effect, Predicate } from "effect";

import type { AppFeatureServiceDraft, RecordedClonedService } from "../services/app-feature-types.ts";
import { appFeatureError } from "./app-feature-error.ts";
import { type DnsNameClaim, dnsNameClaims } from "./dns-name-validation.ts";
import type { PlannedServiceDraft, ResolvedService } from "./service-types.ts";

const COMPOSE_PARENT_PROCESS_KEYS = ["ports", "expose", "healthcheck", "stop_signal"] as const;

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
  "stop_signal",
] as const;

/**
 * True only when the reference itself proves the image has no install shell:
 * the reserved empty `scratch` image (bare name, optional tag or digest) and
 * Google's distroless repositories. A name that merely contains those words
 * does not establish the property.
 */
const imageLacksInstallShell = (image: string | undefined): boolean => {
  if (image === undefined || image.length === 0) return false;
  const reference = image.toLowerCase().split("@")[0] ?? image.toLowerCase();
  const lastSlash = reference.lastIndexOf("/");
  const repositoryPath = lastSlash === -1 ? reference : reference.slice(lastSlash + 1);
  const tagSeparator = repositoryPath.indexOf(":");
  const repository = tagSeparator === -1 ? repositoryPath : repositoryPath.slice(0, tagSeparator);
  if (lastSlash === -1) return repository === "scratch";
  return reference.slice(0, lastSlash) === "gcr.io/distroless" && repository.length > 0;
};

const parentImage = (draft: PlannedServiceDraft["draft"]): string | undefined => {
  // The effective artifact is what an image build runs from, so judge it
  // before the authored image a feature may have replaced.
  const artifact = draft.artifact;
  if (artifact !== undefined && "kind" in artifact && artifact.kind === "ref") return artifact.ref;
  const image = draft.normalizedConfig.image;
  if (typeof image === "string" && image.length > 0) return image;
  return undefined;
};

const cloneConfig = (
  config: ServiceConfig,
  requestKeys: ReadonlyArray<string> | undefined,
): ServiceConfig => {
  const omit = new Set<string>([...CLONE_OMITTED_CONFIG_KEYS, ...(requestKeys ?? [])]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !omit.has(key)));
};

const companionExtensions = (
  extensions: ServicePlan["extensions"],
  resetStopSignal: boolean,
): ServicePlan["extensions"] => {
  const composeExtension = extensions.compose;
  if (!Predicate.isObject(composeExtension) && !resetStopSignal) return { ...extensions };
  const compose = { ...(Predicate.isObject(composeExtension) ? composeExtension : {}) };
  for (const key of COMPOSE_PARENT_PROCESS_KEYS) delete compose[key];
  // An image's stop signal belongs to its server (Apache uses SIGWINCH).
  // The companion replaces that process, so it needs the ordinary TERM signal.
  if (resetStopSignal) compose.stop_signal = "SIGTERM";
  return { ...extensions, compose };
};

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
      // Known limit: with no parent user and a non-root image default user, an
      // inherited unpinned step runs as root on a companion that overrides user.
      return { ...step, user: step.user ?? parentDraft.user ?? "root" };
    });

/**
 * One decision per cloned field: `inherit` copies the parent's value, `drop`
 * leaves an optional key off the clone, and `replace` writes a clone-specific value.
 */
type CloneFieldRule<T, K extends keyof T> =
  | "inherit"
  | { readonly replace: T[K] }
  | (Record<never, never> extends Pick<T, K> ? "drop" : never);

/** Exhaustive over `keyof T`, so a field added to either shape fails typecheck here. */
type CloneFieldRules<T> = { readonly [K in keyof T]-?: CloneFieldRule<T, K> };

const cloneClassifiedFields = <T extends object>(parent: T, rules: CloneFieldRules<T>): T => {
  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Object.keys(rules) as Array<keyof T>) {
    const rule = rules[key];
    if (rule === "drop") continue;
    if (rule === "inherit") {
      // Copy only a key the parent carries, so an absent optional field stays
      // absent instead of becoming an explicit undefined.
      if (Object.hasOwn(parent, key)) clone[key] = parent[key];
      continue;
    }
    clone[key] = rule.replace;
  }
  // The mapped rule type proves the table covers every field; this assertion
  // only bridges the record the loop builds, which TypeScript cannot type.
  return clone as T;
};

const clonePlannedDraft = (
  parent: PlannedServiceDraft,
  request: RecordedClonedService,
  resetStopSignal: boolean,
): PlannedServiceDraft => {
  const name = ServiceName.make(request.name);
  const extraEnv = request.extraEnv ?? {};
  const extraBuildSteps = request.extraBuildSteps ?? [];
  const parentDraft = parent.draft;
  const draftRules = {
    name: { replace: name },
    type: "inherit",
    serviceTypeId: "inherit",
    provider: "inherit",
    primary: { replace: false },
    artifact: "inherit",
    // The requested argv is the clone's whole process, so the parent's command
    // does not carry over.
    command: "drop",
    // An entrypoint without a command replaces the image ENTRYPOINT and
    // suppresses its CMD instead of appending to the parent's entrypoint.
    entrypoint:
      typeof request.command === "string"
        ? { replace: ["sh", "-c", request.command] }
        : { replace: [...request.command] },
    init: "inherit",
    environment: { replace: { ...parentDraft.environment, ...extraEnv } },
    // Database identity and seeded ownership describe the parent's data.
    connection: "drop",
    nonSqlCreds: "drop",
    sqlite: "drop",
    user: request.user === undefined ? "inherit" : { replace: request.user },
    workingDirectory: "inherit",
    appMount: parentDraft.appMount === undefined ? "drop" : { replace: { ...parentDraft.appMount } },
    mounts: { replace: parentDraft.mounts.map((mount) => ({ ...mount })) },
    featureIds: "inherit",
    buildSteps: {
      replace: [
        ...inheritedBuildSteps(parentDraft, request),
        ...extraBuildSteps.map((step) => ({ ...step })),
      ],
    },
    extensions: "inherit",
    storage: { replace: parentDraft.storage.map((entry) => ({ ...entry })) },
    // A clone seeds no data of its own, so it owns no mounted tree.
    storageOwnership: "drop",
    endpoints: { replace: [] },
    dependsOn: {
      replace: [
        ...parentDraft.dependsOn.map((dependency) => ({ ...dependency })),
        { service: ServiceName.make(parent.name), condition: "service_started", required: true },
      ],
    },
    // A clone may inherit an image HEALTHCHECK aimed at the parent's server,
    // so disable it explicitly instead of leaving it absent.
    healthcheck: { replace: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 5 } },
    // Listener, probe, route, and certificate intent describe the parent's
    // network presence, which a companion does not repeat.
    readiness: "drop",
    readinessSource: "drop",
    listenerAuthority: "drop",
    certs: "drop",
    hostAliases: { replace: parentDraft.hostAliases.map((alias) => ({ ...alias })) },
    provenance: {
      replace: {
        ...(parentDraft.provenance ?? {}),
        [CLONED_SERVICE_PROVENANCE_KEY]: { feature: request.feature, from: request.from },
      },
    },
    serviceName: { replace: request.name },
    serviceType: "inherit",
    base: "inherit",
    framework: "inherit",
    normalizedConfig: {
      replace: {
        ...cloneConfig(parentDraft.normalizedConfig, request.omitConfigKeys),
        ...(request.user === undefined ? {} : { user: request.user }),
      },
    },
    resolutionMetadata: "inherit",
  } satisfies CloneFieldRules<AppFeatureServiceDraft>;
  const plannedRules = {
    name: { replace: name },
    authoredStorage: "inherit",
    hostnames: { replace: [] },
    authoredArtifact: "inherit",
    pullPolicy: "inherit",
    authored: "inherit",
    // A different principal cannot share the parent's home store, and preparing
    // a new one would insert a build step before the inherited layers.
    homeIntent:
      request.user === undefined
        ? "inherit"
        : { replace: { serviceType: parent.homeIntent.serviceType, home: false } },
    draft: { replace: cloneClassifiedFields(parentDraft, draftRules) },
    // Log files belong to the parent's process. Following them would also append
    // the parent's redirect build steps after the request's own extra steps.
    logSources: { replace: [] },
    routes: { replace: undefined },
    extensions: { replace: companionExtensions(parent.extensions ?? {}, resetStopSignal) },
    // The clone shares the parent's service-scoped stores: same files, same
    // dependencies. A user override drops home persistence, so it mounts no
    // home store here or in finalize.
    storeOwner: { replace: parent.name },
  } satisfies CloneFieldRules<PlannedServiceDraft>;
  return cloneClassifiedFields(parent, plannedRules);
};

const networksWithoutAliases = (
  networks: ServiceConfig["networks"] | undefined,
): ServiceConfig["networks"] | undefined =>
  networks === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(networks).map(([key, attachment]) => {
          const { aliases: _aliases, ...membership } = attachment;
          return [key, membership];
        }),
      );

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
  readonly capabilities?: Pick<ProviderCapabilities, "composeSpec" | "composeKnobs">;
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
    drafts.push(
      clonePlannedDraft(
        parent,
        request,
        input.capabilities?.composeSpec === "native" &&
          input.capabilities.composeKnobs?.supported.includes("stop_signal") === true,
      ),
    );
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
    capabilities,
  }: {
    readonly clones: ReadonlyArray<RecordedClonedService>;
    readonly resolvedServices: ReadonlyArray<Pick<ResolvedService, "name" | "service">>;
    readonly appRoot: string;
    readonly appSlug: string;
    readonly capabilities: ProviderCapabilities;
  },
) {
  const cloned = yield* Effect.try({
    try: () =>
      materializeClonedServices({
        plannedServiceDrafts,
        clones,
        parentNetworksByName: new Map(resolvedServices.map((entry) => [entry.name, entry.service.networks])),
        appSlug,
        capabilities,
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
