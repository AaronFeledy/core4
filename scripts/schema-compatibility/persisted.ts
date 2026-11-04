import { APPLIED_STATE_VERSION } from "@lando/container-runtime/applied-state";
import { TUNNEL_REGISTRY_VERSION } from "../../engine/src/tunnel/registry-migrate.ts";

import type { JsonSchema, JsonValue, PersistedStoreId } from "./model.ts";
import { isJsonObject } from "./model.ts";
import { persistedShallowKeys, persistedShapeKeys, publishedShapeKey } from "./persisted-shapes.ts";

/**
 * Published schema roots decoded from durable state stores.
 * Ref names and normalized inline shapes identify published nested contracts.
 * Bare scalars and open dictionaries need explicit domain names because their
 * JSON Schema shapes also match unrelated contracts.
 */
const PERSISTED_SCHEMA_ROOTS = [
  { schemaId: "AppPlan", store: "applied-state" },
  { schemaId: "TunnelSession", store: "tunnel-registry" },
] as const satisfies ReadonlyArray<{ readonly schemaId: string; readonly store: PersistedStoreId }>;

/** Separately published plan/tunnel surfaces embedded in the roots above. */
const PERSISTED_COMPONENT_SCHEMA_IDS = {
  "applied-state": [
    "ServicePlan",
    "RoutePlan",
    "HostAliasPlan",
    "CertificatePlan",
    "HostAliasName",
    "CertificateName",
    "RouteHostname",
    "AppId",
    "ServiceName",
    "ProviderId",
    "PortNumber",
    "PortablePath",
    "AbsolutePath",
    "AbsoluteContainerPath",
    "ProviderExtensionConfig",
  ],
  "tunnel-registry": ["TunnelTarget", "RouteHostname", "AppId", "ServiceName", "PortNumber"],
} as const satisfies Record<PersistedStoreId, ReadonlyArray<string>>;

const DEF_SUFFIX = /_\d+$/;

const normalizeSchemaDefName = (name: string): string => name.replace(DEF_SUFFIX, "");

const collectLocalRefNames = (value: JsonValue, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalRefNames(entry, into);
    return;
  }
  if (!isJsonObject(value)) return;
  const ref = value.$ref;
  if (typeof ref === "string") {
    const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
    if (match?.[1] !== undefined) into.add(decodeURIComponent(match[1]));
  }
  for (const child of Object.values(value)) collectLocalRefNames(child, into);
};

/** Local `$defs` / `definitions` names and `$ref` targets reachable inside one document. */
const collectJsonSchemaRefNames = (schema: JsonSchema): ReadonlySet<string> => {
  const names = new Set<string>();
  collectLocalRefNames(schema, names);
  const defs = schema.$defs ?? schema.definitions;
  if (isJsonObject(defs)) {
    for (const name of Object.keys(defs)) names.add(name);
  }
  return names;
};

/**
 * Map `schema:<Id>` surfaces onto the durable store(s) that decode them.
 * `publishedSchemaIds` is the set of public schema ids (without the `schema:` prefix).
 */
export const buildPersistedSurfaceStores = (
  rootSchemas: ReadonlyMap<string, JsonSchema>,
  publishedSchemaIds: ReadonlySet<string>,
  previousRootSchemas: ReadonlyMap<string, JsonSchema> = new Map(),
): ReadonlyMap<string, ReadonlySet<PersistedStoreId>> => {
  const storesBySurface = new Map<string, Set<PersistedStoreId>>();
  const rootDocuments = PERSISTED_SCHEMA_ROOTS.flatMap(({ schemaId }) => [
    rootSchemas.get(schemaId),
    previousRootSchemas.get(schemaId),
  ]).filter((schema) => schema !== undefined);
  const shallowKeys = persistedShallowKeys(rootDocuments);
  const publishedShapes = [...publishedSchemaIds].map((schemaId) => ({
    schemaId,
    keys: [rootSchemas.get(schemaId), previousRootSchemas.get(schemaId)].flatMap((schema) => {
      const key = schema === undefined ? undefined : publishedShapeKey(schema, shallowKeys);
      return key === undefined ? [] : [key];
    }),
  }));

  const add = (schemaId: string, store: PersistedStoreId): void => {
    if (!publishedSchemaIds.has(schemaId)) return;
    const surface = `schema:${schemaId}`;
    const existing = storesBySurface.get(surface);
    if (existing === undefined) storesBySurface.set(surface, new Set([store]));
    else existing.add(store);
  };

  for (const root of PERSISTED_SCHEMA_ROOTS) {
    add(root.schemaId, root.store);
    for (const schema of [rootSchemas.get(root.schemaId), previousRootSchemas.get(root.schemaId)]) {
      if (schema === undefined) continue;
      for (const defName of collectJsonSchemaRefNames(schema)) {
        const normalized = normalizeSchemaDefName(defName);
        add(normalized, root.store);
        if (normalized !== defName) add(defName, root.store);
      }
      const shapes = persistedShapeKeys(schema);
      for (const published of publishedShapes) {
        if (published.keys.some((key) => shapes.has(key))) add(published.schemaId, root.store);
      }
    }
    for (const componentId of PERSISTED_COMPONENT_SCHEMA_IDS[root.store]) {
      add(componentId, root.store);
    }
  }

  return storesBySurface;
};

export const readPersistedStoreVersions = (): Readonly<Record<PersistedStoreId, number>> => ({
  "applied-state": APPLIED_STATE_VERSION,
  "tunnel-registry": TUNNEL_REGISTRY_VERSION,
});

export const persistedMigrationRemediation = (
  stores: ReadonlySet<PersistedStoreId>,
  storeVersions: Readonly<Record<PersistedStoreId, number>>,
): string => {
  const ordered = [...stores].sort();
  const examples = ordered.map((store) => `{"store":"${store}","version":${storeVersions[store]}}`).join(",");
  const metadata = ordered.length === 1 ? examples : `[${examples}]`;
  return `Persisted schema surface: accept only with matching exception.persistedState (${metadata}). Bump each store's version and add a migration that rewrites historical records, then set persistedState to the new version.`;
};
