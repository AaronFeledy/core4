import { Effect } from "effect";

import { ServiceTypeCollisionError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { FeatureRef, ServiceType, ServiceTypeInput, ServiceTypeResolution } from "@lando/sdk/services";

import { mergeValues } from "../landofile/merge.ts";

/** Single inheritance chain, depth-limited to at most four `extends` hops. */
export const MAX_SERVICE_TYPE_EXTENDS_DEPTH = 4;

const mergeServiceConfig = (parent: ServiceConfig, child: ServiceConfig): ServiceConfig =>
  mergeValues(parent, child) as ServiceConfig;

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
        ? (mergeValues(existing.config, feature.config) as Record<string, unknown>)
        : (feature.config ?? existing.config);
    byId.set(feature.id, {
      id: feature.id,
      ...(mergedConfig === undefined ? {} : { config: mergedConfig }),
    });
  }
  return order.map((id) => byId.get(id) as FeatureRef);
};

const mergeOptionalRecord = <T>(
  parent: Readonly<Record<string, T>> | undefined,
  child: Readonly<Record<string, T>> | undefined,
): Readonly<Record<string, T>> | undefined => {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  return mergeValues(parent, child) as Record<string, T>;
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

/**
 * Overlay a child resolution onto its parent: deep-merge normalized config,
 * merge features by id, merge logSources by id (child wins), child-wins for
 * tooling/metadata. The child's declared `base` is authoritative.
 */
export const mergeResolutionOverParent = (
  parent: ServiceTypeResolution,
  child: ServiceTypeResolution,
): ServiceTypeResolution => {
  const tooling = mergeOptionalRecord(parent.tooling, child.tooling);
  const metadata = mergeOptionalRecord(parent.metadata, child.metadata) as
    | Record<string, unknown>
    | undefined;
  const logSources = mergeLogSources(parent.logSources, child.logSources);
  return {
    base: child.base,
    normalizedConfig: mergeServiceConfig(parent.normalizedConfig, child.normalizedConfig),
    features: mergeFeatures(parent.features, child.features),
    ...(logSources === undefined ? {} : { logSources }),
    ...(tooling === undefined ? {} : { tooling }),
    ...(metadata === undefined ? {} : { metadata }),
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
export const resolveExtendsChain = (
  leaf: ServiceType,
  lookup: (id: string) => ServiceType | undefined,
): Effect.Effect<ReadonlyArray<ServiceType>, ServiceTypeCollisionError> =>
  Effect.gen(function* () {
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

export const composeExtendedServiceType = (
  leaf: ServiceType,
  lookup: (id: string) => ServiceType | undefined,
): Effect.Effect<ServiceType, ServiceTypeCollisionError> => {
  if (leaf.extends === undefined) return Effect.succeed(leaf);
  return Effect.gen(function* () {
    const chain = yield* resolveExtendsChain(leaf, lookup);
    const mergedArtifacts = mergeArtifacts(chain);
    const mergedVersions = mergeVersions(chain);
    const resolve = (input: ServiceTypeInput): ReturnType<ServiceType["resolve"]> =>
      Effect.gen(function* () {
        let accumulated: ServiceTypeResolution | undefined = input.parentResolution;
        for (const type of chain) {
          const resolution = yield* type.resolve({
            ...input,
            ...(accumulated === undefined ? {} : { parentResolution: accumulated }),
          });
          accumulated =
            accumulated === undefined ? resolution : mergeResolutionOverParent(accumulated, resolution);
        }
        return accumulated as ServiceTypeResolution;
      });
    return {
      ...leaf,
      resolve,
      ...(mergedArtifacts === undefined ? {} : { artifacts: mergedArtifacts }),
      ...(mergedVersions === undefined ? {} : { versions: mergedVersions }),
    } satisfies ServiceType;
  });
};
