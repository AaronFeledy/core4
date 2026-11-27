import { canonicalJson } from "@lando/sdk/digest";
import { ServiceTypeCollisionError } from "@lando/sdk/errors";
import { mergeValues } from "@lando/sdk/landofile";
import { LandofileShape, ServiceConfig, sameImageReference } from "@lando/sdk/schema";
import type {
  FeatureRef,
  ServiceImageIdentity,
  ServiceType,
  ServiceTypeInput,
  ServiceTypeResolution,
} from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { launcherPrefix } from "../planner/launchers.ts";
import { normalizeConnectionClients } from "./connection-client-resolution.ts";

/** Single inheritance chain, depth-limited to at most four `extends` hops. */
export const MAX_SERVICE_TYPE_EXTENDS_DEPTH = 4;

const mergeServiceConfig = (parent: ServiceConfig, child: ServiceConfig): ServiceConfig =>
  mergeValues(ServiceConfig, parent, child) as ServiceConfig;

/**
 * Feature lists merge by id: parent features come first; a child `FeatureRef`
 * with the same `id` overrides the parent (configs deep-merge). New child
 * features append in declared order.
 */
const mergeFeatures = (
  parent: ReadonlyArray<FeatureRef>,
  child: ReadonlyArray<FeatureRef>,
): ReadonlyArray<FeatureRef> => {
  const order: Array<string> = [];
  const byId = new Map<string, FeatureRef>();
  for (const feature of parent) {
    if (!byId.has(feature.id)) order.push(feature.id);
    byId.set(feature.id, feature);
  }
  for (const feature of child) {
    const existing = byId.get(feature.id);
    if (existing === undefined) {
      order.push(feature.id);
      byId.set(feature.id, feature);
      continue;
    }
    const mergedConfig =
      existing.config !== undefined && feature.config !== undefined
        ? (mergeValues(Schema.Unknown, existing.config, feature.config) as Record<string, unknown>)
        : (feature.config ?? existing.config);
    byId.set(feature.id, {
      id: feature.id,
      ...(mergedConfig === undefined ? {} : { config: mergedConfig }),
    });
  }
  return order.map((id) => byId.get(id) as FeatureRef);
};

const mergeOptionalRecord = <T>(
  root: Schema.Top,
  parent: Readonly<Record<string, T>> | undefined,
  child: Readonly<Record<string, T>> | undefined,
  path: ReadonlyArray<string> = [],
): Readonly<Record<string, T>> | undefined => {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return mergeValues(root, parent, child, path) as Record<string, T>;
};

/**
 * Log sources merge by id: parent sources come first; a child source with the
 * same id overrides the parent. New child sources append in declared order.
 */
const mergeLogSources = (
  parent: ServiceTypeResolution["logSources"],
  child: ServiceTypeResolution["logSources"],
): ServiceTypeResolution["logSources"] => {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  const order: Array<string> = [];
  const byId = new Map<string, NonNullable<ServiceTypeResolution["logSources"]>[number]>();
  for (const source of parent) {
    const id = String(source.id);
    if (!byId.has(id)) order.push(id);
    byId.set(id, source);
  }
  for (const source of child) {
    const id = String(source.id);
    if (!byId.has(id)) order.push(id);
    byId.set(id, source);
  }
  const merged: Array<NonNullable<ServiceTypeResolution["logSources"]>[number]> = [];
  for (const id of order) {
    const source = byId.get(id);
    if (source !== undefined) merged.push(source);
  }
  return merged;
};

const replacementBuild = (config: ServiceConfig) =>
  config.build !== undefined && "context" in config.build ? config.build : undefined;

const changed = (next: unknown, previous: unknown): boolean =>
  next !== undefined && (previous === undefined || canonicalJson(next) !== canonicalJson(previous));

/**
 * Whether the child replaces the launcher its parent owned: a new image, a
 * replacement `build.context`, a command, or an entrypoint. Additive
 * `build.artifact` and `build.app` steps keep the parent's launcher.
 */
const ownershipChanged = (parent: ServiceConfig, child: ServiceConfig): boolean =>
  changed(replacementBuild(child), replacementBuild(parent)) ||
  changed(child.command, parent.command) ||
  changed(child.entrypoint, parent.entrypoint) ||
  (child.image !== undefined &&
    (parent.image === undefined || !sameImageReference(parent.image, child.image)));

/** Launchers merge by marker: a child entry replaces the parent's, omitted markers are inherited. */
const mergeLaunchers = (
  parent: ServiceTypeResolution["launchers"],
  child: ServiceTypeResolution["launchers"],
): ServiceTypeResolution["launchers"] =>
  parent === undefined ? child : child === undefined ? parent : { ...parent, ...child };

/**
 * The service-owned generated-listener association survives inheritance unless
 * the child replaces the launcher whose owned configuration could serve the
 * generated certificate, including a different prefix for the command's marker.
 */
const mergeGeneratedCertificateEndpoint = (
  parent: ServiceTypeResolution,
  child: ServiceTypeResolution,
  launchers: ServiceTypeResolution["launchers"],
): ServiceTypeResolution["generatedCertificateEndpoint"] => {
  if (child.generatedCertificateEndpoint !== undefined) return child.generatedCertificateEndpoint;
  const command = parent.normalizedConfig.command;
  const head = typeof command === "string" ? undefined : command?.[0];
  const prefixChanged =
    canonicalJson(launcherPrefix(head, parent.launchers) ?? null) !==
    canonicalJson(launcherPrefix(head, launchers) ?? null);
  return ownershipChanged(parent.normalizedConfig, child.normalizedConfig) || prefixChanged
    ? undefined
    : parent.generatedCertificateEndpoint;
};

/**
 * Overlay a child resolution onto its parent: deep-merge normalized config,
 * merge features by id, merge logSources by id (child wins), child-wins per key
 * for tooling, metadata, and launchers. The child's declared `base` is authoritative.
 */
export const mergeResolutionOverParent = (
  parent: ServiceTypeResolution,
  child: ServiceTypeResolution,
): ServiceTypeResolution => {
  const tooling = mergeOptionalRecord(LandofileShape, parent.tooling, child.tooling, ["tooling"]);
  const metadata = mergeOptionalRecord(Schema.Unknown, parent.metadata, child.metadata) as
    | Record<string, unknown>
    | undefined;
  const logSources = mergeLogSources(parent.logSources, child.logSources);
  const launchers = mergeLaunchers(parent.launchers, child.launchers);
  const generatedCertificateEndpoint = mergeGeneratedCertificateEndpoint(parent, child, launchers);
  const source = child.connection !== undefined || child.nonSqlCreds !== undefined ? child : parent;
  return {
    base: child.base,
    normalizedConfig: mergeServiceConfig(parent.normalizedConfig, child.normalizedConfig),
    features: mergeFeatures(parent.features, child.features),
    ...(launchers === undefined ? {} : { launchers }),
    ...(source.connection === undefined ? {} : { connection: source.connection }),
    ...(source.nonSqlCreds === undefined ? {} : { nonSqlCreds: source.nonSqlCreds }),
    ...(logSources === undefined ? {} : { logSources }),
    ...(tooling === undefined ? {} : { tooling }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(generatedCertificateEndpoint === undefined ? {} : { generatedCertificateEndpoint }),
  };
};

const collisionError = (
  serviceType: string,
  chain: ReadonlyArray<string>,
  message: string,
  remediation: string,
): ServiceTypeCollisionError => new ServiceTypeCollisionError({ message, serviceType, chain, remediation });

/**
 * Resolve a service type's `extends:` chain root-to-leaf at load time. Returns
 * the ordered chain (root parent first, requested type last). Rejects cycles
 * and chains deeper than {@link MAX_SERVICE_TYPE_EXTENDS_DEPTH} hops with
 * {@link ServiceTypeCollisionError} before any `resolve()` runs.
 */
export const resolveExtendsChain = Effect.fnUntraced(function* (
  leaf: ServiceType,
  lookup: (id: string) => ServiceType | undefined,
): Effect.fn.Return<ReadonlyArray<ServiceType>, ServiceTypeCollisionError> {
  const descending: Array<ServiceType> = [leaf];
  const seen = new Set<string>([leaf.id]);
  let current = leaf;
  let hops = 0;
  while (current.extends !== undefined) {
    hops += 1;
    const parentId = current.extends;
    if (hops > MAX_SERVICE_TYPE_EXTENDS_DEPTH) {
      const chain = [parentId, ...descending.map((entry) => entry.id)];
      return yield* Effect.fail(
        collisionError(
          leaf.id,
          chain,
          `Service type ${leaf.id} exceeds the maximum extends depth of ${MAX_SERVICE_TYPE_EXTENDS_DEPTH}.`,
          `Flatten the inheritance chain so no service type extends more than ${MAX_SERVICE_TYPE_EXTENDS_DEPTH} parents.`,
        ),
      );
    }
    if (seen.has(parentId)) {
      const chain = [parentId, ...descending.map((entry) => entry.id)];
      return yield* Effect.fail(
        collisionError(
          leaf.id,
          chain,
          `Service type ${leaf.id} has a cyclic extends chain through ${parentId}.`,
          "Remove the cycle so the inheritance chain terminates at a base service type.",
        ),
      );
    }
    const parent = lookup(parentId);
    if (parent === undefined) {
      const chain = [parentId, ...descending.map((entry) => entry.id)];
      return yield* Effect.fail(
        collisionError(
          leaf.id,
          chain,
          `Service type ${leaf.id} extends unregistered parent ${parentId}.`,
          `Register a service type with id ${parentId} or correct the extends reference.`,
        ),
      );
    }
    seen.add(parentId);
    descending.push(parent);
    current = parent;
  }
  return descending.reverse();
});

const mergeArtifacts = (chain: ReadonlyArray<ServiceType>): Readonly<Record<string, string>> | undefined => {
  let merged: Record<string, string> | undefined;
  for (const type of chain) {
    if (type.artifacts === undefined) continue;
    merged = { ...(merged ?? {}), ...type.artifacts };
  }
  return merged;
};

/**
 * Identity merges root-to-leaf: sole declaration wins; when both sides declare,
 * the child's `defaultUser` wins and `homes` shallow-merge with child keys overriding.
 */
const mergeIdentity = (chain: ReadonlyArray<ServiceType>): ServiceImageIdentity | undefined => {
  let merged: ServiceImageIdentity | undefined;
  for (const type of chain) {
    if (type.identity === undefined) continue;
    if (merged === undefined) {
      merged = type.identity;
      continue;
    }
    merged = {
      ...type.identity,
      homes: { ...merged.homes, ...type.identity.homes },
      ...(merged.preparedHomes === undefined && type.identity.preparedHomes === undefined
        ? {}
        : {
            preparedHomes: Array.from(
              new Set([...(merged.preparedHomes ?? []), ...(type.identity.preparedHomes ?? [])]),
            ),
          }),
    };
  }
  return merged;
};

const mergeVersions = (chain: ReadonlyArray<ServiceType>): ReadonlyArray<string> | undefined => {
  const ordered: Array<string> = [];
  const seen = new Set<string>();
  for (const type of chain) {
    for (const version of type.versions ?? []) {
      if (seen.has(version)) continue;
      seen.add(version);
      ordered.push(version);
    }
  }
  return ordered.length === 0 ? undefined : ordered;
};

export const composeExtendedServiceType = Effect.fn("ServiceType.composeExtended")(function* (
  leaf: ServiceType,
  lookup: (id: string) => ServiceType | undefined,
): Effect.fn.Return<ServiceType, ServiceTypeCollisionError> {
  if (leaf.extends === undefined) return leaf;
  const chain = yield* resolveExtendsChain(leaf, lookup);
  const mergedArtifacts = mergeArtifacts(chain);
  const mergedIdentity = mergeIdentity(chain);
  const mergedVersions = mergeVersions(chain);
  const factory = chain.findLast((type) => type.toolingForConnection !== undefined)?.toolingForConnection;
  const resolve = Effect.fn("ServiceType.resolve")(function* (input: ServiceTypeInput) {
    let accumulated: ServiceTypeResolution | undefined = input.parentResolution;
    let inheritedFactory: ServiceType["toolingForConnection"];
    for (const type of chain) {
      const resolution = yield* type.resolve({
        ...input,
        ...(accumulated === undefined ? {} : { parentResolution: accumulated }),
      });
      accumulated = yield* normalizeConnectionClients(type, input.name, {
        raw: resolution,
        ...(accumulated === undefined
          ? {}
          : {
              parent: accumulated,
              merged: mergeResolutionOverParent(accumulated, resolution),
            }),
        inheritedFactory,
      });
      inheritedFactory = type.toolingForConnection ?? inheritedFactory;
    }
    return accumulated as ServiceTypeResolution;
  });
  return {
    ...leaf,
    resolve,
    ...(factory === undefined ? {} : { toolingForConnection: factory }),
    ...(mergedArtifacts === undefined ? {} : { artifacts: mergedArtifacts }),
    ...(mergedIdentity === undefined ? {} : { identity: mergedIdentity }),
    ...(mergedVersions === undefined ? {} : { versions: mergedVersions }),
  } satisfies ServiceType;
});
