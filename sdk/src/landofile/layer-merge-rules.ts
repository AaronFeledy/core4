import { posix } from "node:path";
import type { Schema } from "effect";
import { endpointShorthandAlias } from "../schema/endpoint-shorthand.ts";
import type { LayerMergeRule } from "../schema/layer-merge.ts";
import { layerMergeRuleAt } from "./layer-merge-trie.ts";
import { isPlainRecord } from "./record.ts";
import { expandRouteSchemes, routeInputKey, routeInputObject } from "./route-input.ts";

export type RouteFilterIdentity =
  | { readonly kind: "name"; readonly value: unknown }
  | { readonly kind: "kind"; readonly value: unknown };

/** Named filters never match unnamed filters, even when their text is identical. */
export const routeFilterIdentity = (item: unknown): RouteFilterIdentity | undefined => {
  if (!isPlainRecord(item)) return undefined;
  if (Object.hasOwn(item, "name")) return { kind: "name", value: item.name };
  if (Object.hasOwn(item, "kind")) return { kind: "kind", value: item.kind };
  return undefined;
};

/** Compare filter identities for single-route filter attachment. */
export const routeFilterMatches = (left: unknown, right: unknown): boolean => {
  const a = routeFilterIdentity(left);
  const b = routeFilterIdentity(right);
  return a !== undefined && b !== undefined && a.kind === b.kind && a.value === b.value;
};

const entries = (value: unknown): ReadonlyArray<unknown> | undefined =>
  Array.isArray(value) ? value : undefined;
const identityText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const fieldKey =
  (field: string) =>
  (item: unknown): string | undefined =>
    isPlainRecord(item) ? identityText(item[field]) : undefined;
const dependencyEntries = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (Array.isArray(value)) {
    if (!value.every((item): item is string => typeof item === "string")) return undefined;
    return value.map((service) => ({ service }));
  }
  if (!isPlainRecord(value) || Object.hasOwn(value, "__proto__")) return undefined;
  const projected = [];
  for (const [service, spec] of Object.entries(value)) {
    if (!isPlainRecord(spec) || Object.hasOwn(spec, "service")) return undefined;
    projected.push({ ...spec, service });
  }
  return projected;
};
const ruleImplementation = (identity: Extract<LayerMergeRule, { kind: "keyed" }>["identity"]) => {
  switch (identity) {
    case "route-match":
      return {
        entries: (value: unknown) => entries(value)?.flatMap(expandRouteSchemes),
        parts: expandRouteSchemes,
        key: routeInputKey,
        preserveDuplicates: true,
        matched: (value: unknown) => routeInputObject(value) ?? value,
      };
    case "dependency-service":
      return {
        entries: dependencyEntries,
        key: fieldKey("service"),
        preserveDuplicates: false,
        matched: (value: unknown) => value,
      };
    case "log-id":
      return {
        preserveDuplicates: false,
        entries,
        key: (item: unknown) => {
          if (!isPlainRecord(item)) return undefined;
          return identityText(
            item.id ?? (typeof item.path === "string" ? posix.basename(item.path) : undefined),
          );
        },
        matched: (value: unknown) => value,
      };
    case "endpoint-name":
      return {
        entries,
        key: (item: unknown) =>
          typeof item === "string" ? endpointShorthandAlias(item) : fieldKey("name")(item),
        preserveDuplicates: false,
        // A list may repeat a name across facets; such a list has no keyed identity.
        requiresUniqueKeys: true,
        matched: (value: unknown) => value,
      };
    case "port-name":
      return {
        entries,
        key: fieldKey("name"),
        preserveDuplicates: false,
        matched: (value: unknown) => value,
      };
    case "filter-name-or-kind":
      return {
        preserveDuplicates: false,
        entries,
        key: (item: unknown) => {
          const identity = routeFilterIdentity(item);
          if (identity === undefined) return undefined;
          const text = identityText(identity.value);
          return text === undefined ? undefined : JSON.stringify([identity.kind, text]);
        },
        matched: (value: unknown) => value,
      };
  }
};

/** Resolve a schema collection policy and its authored-value projection and identity. */
export const resolveLayerMergeRule = (root: Schema.Top, path: ReadonlyArray<string | number> = []) => {
  const descriptor = layerMergeRuleAt(root, path);
  return descriptor.kind === "replace"
    ? {
        descriptor,
        preserveDuplicates: false,
        requiresUniqueKeys: false,
        parts: (value: unknown): ReadonlyArray<unknown> => [value],
        entries,
        key: (_item: unknown): string | undefined => undefined,
        matched: (value: unknown) => value,
      }
    : {
        descriptor,
        parts: (value: unknown): ReadonlyArray<unknown> => [value],
        requiresUniqueKeys: false,
        ...ruleImplementation(descriptor.identity),
      };
};
