import { posix } from "node:path";
import type { Schema } from "effect";
import type { LayerMergeRule } from "../schema/layer-merge.ts";
import { layerMergeRuleAt } from "./layer-merge-trie.ts";
import { isPlainRecord } from "./record.ts";
import { expandRouteSchemes, routeInputKey, routeInputObject } from "./route-input.ts";

export type RouteFilterIdentity =
  | { readonly kind: "name"; readonly value: unknown }
  | { readonly kind: "type"; readonly value: unknown };

/** Named filters never match unnamed filters, even when their text is identical. */
export const routeFilterIdentity = (item: unknown): RouteFilterIdentity | undefined => {
  if (!isPlainRecord(item)) return undefined;
  if (Object.hasOwn(item, "name")) return { kind: "name", value: item.name };
  if (Object.hasOwn(item, "type")) return { kind: "type", value: item.type };
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
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? { service: item } : item));
  if (!isPlainRecord(value)) return undefined;
  return Object.entries(value).map(([service, spec]) =>
    isPlainRecord(spec) ? { ...spec, service } : { service, condition: spec },
  );
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
    case "port-name":
      return {
        entries,
        key: fieldKey("name"),
        preserveDuplicates: false,
        matched: (value: unknown) => value,
      };
    case "filter-name-or-type":
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
        parts: (value: unknown): ReadonlyArray<unknown> => [value],
        entries,
        key: (_item: unknown): string | undefined => undefined,
        matched: (value: unknown) => value,
      }
    : {
        descriptor,
        parts: (value: unknown): ReadonlyArray<unknown> => [value],
        ...ruleImplementation(descriptor.identity),
      };
};
