import { isPlainRecord, resolveLayerMergeRule } from "@lando/sdk/landofile";
import { type ConfigTranslateSourceId, type LandofileLayer, LandofileShape } from "@lando/sdk/schema";

export type UnitSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "item"; readonly key: string; readonly identity: string };
export type Path = ReadonlyArray<UnitSegment>;
export interface Relocation {
  readonly unitPath: Path;
  readonly hoistedTo: LandofileLayer;
  readonly omittedFrom: ReadonlyArray<LandofileLayer>;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly changedPrefixes: ReadonlyArray<LandofileLayer>;
}
const absent = Symbol("absent");

export const equal = (left: unknown, right: unknown, path: ReadonlyArray<string | number> = []): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    const rule = resolveLayerMergeRule(LandofileShape, path);
    const routeCollection = rule.descriptor.kind === "keyed" && rule.descriptor.identity === "route-match";
    const a = routeCollection ? (rule.entries(left) ?? left) : left;
    const b = routeCollection ? (rule.entries(right) ?? right) : right;
    return a.length === b.length && a.every((value, i) => equal(value, b[i], [...path, i]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key], [...path, key]),
    )
  );
};
export const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
};
export const record = (value: unknown): Record<string, unknown> => {
  if (!isPlainRecord(value)) throw new Error("Layer delta must be a record");
  return value;
};

/**
 * dependsOn is a string list in the authoring fragment and an identity-keyed
 * object list after Landofile decode. A higher layer cannot delete an entry
 * the decode-then-merge kept, so a service that the final layer does not have
 * must not be named by any emitted dependsOn.
 */
export const dropRemovedServiceDependencies = (
  fragments: ReadonlyArray<Record<string, unknown>>,
  relocations: ReadonlyArray<Relocation>,
  finalDesired: Readonly<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> => {
  const finalServices = isPlainRecord(finalDesired.services) ? finalDesired.services : {};
  const removed = new Set<string>();
  for (const relocation of relocations) {
    const [services, name] = relocation.unitPath;
    if (
      relocation.unitPath.length === 2 &&
      services?.kind === "key" &&
      services.key === "services" &&
      name?.kind === "key" &&
      !Object.hasOwn(finalServices, name.key)
    )
      removed.add(name.key);
  }
  if (removed.size === 0) return fragments;
  return fragments.map((fragment) => stripDependsOn(fragment, removed));
};
const dependencyKept = (entry: unknown, removed: ReadonlySet<string>): boolean => {
  if (typeof entry === "string") return !removed.has(entry);
  return !(isPlainRecord(entry) && typeof entry.service === "string" && removed.has(entry.service));
};
const stripDependsOn = (
  fragment: Readonly<Record<string, unknown>>,
  removed: ReadonlySet<string>,
): Record<string, unknown> => {
  const services = fragment.services;
  if (!isPlainRecord(services)) return fragment;
  let changed = false;
  const nextServices: Record<string, unknown> = {};
  for (const [name, service] of Object.entries(services)) {
    if (!isPlainRecord(service) || !Array.isArray(service.dependsOn)) {
      nextServices[name] = service;
      continue;
    }
    const dependsOn = service.dependsOn.filter((entry) => dependencyKept(entry, removed));
    if (dependsOn.length === service.dependsOn.length) {
      nextServices[name] = service;
      continue;
    }
    changed = true;
    nextServices[name] = { ...service, dependsOn };
  }
  return changed ? { ...fragment, services: nextServices } : fragment;
};

export const schemaPath = (path: Path): ReadonlyArray<string | number> =>
  path.flatMap((segment): (string | number)[] =>
    segment.kind === "item" ? [segment.key, 0] : [segment.key],
  );
const itemMatches = (
  item: unknown,
  segment: Extract<UnitSegment, { kind: "item" }>,
  path: ReadonlyArray<string | number>,
): boolean => resolveLayerMergeRule(LandofileShape, path).key(item) === segment.identity;
export const atPath = (value: unknown, path: Path, prefix: ReadonlyArray<string | number> = []): unknown => {
  const [segment, ...rest] = path;
  if (segment === undefined) return value;
  if (!isPlainRecord(value) || !Object.hasOwn(value, segment.key)) return absent;
  const child = value[segment.key];
  switch (segment.kind) {
    case "key":
      return atPath(child, rest, [...prefix, segment.key]);
    case "item": {
      const collectionPath = [...prefix, segment.key];
      const item = resolveLayerMergeRule(LandofileShape, collectionPath)
        .entries(child)
        ?.find((entry) => itemMatches(entry, segment, collectionPath));
      return item === undefined ? absent : atPath(item, rest, [...collectionPath, 0]);
    }
    default:
      return segment satisfies never;
  }
};
export const omit = (value: unknown, path: Path, prefix: ReadonlyArray<string | number> = []): unknown => {
  const [segment, ...rest] = path;
  if (segment === undefined) return absent;
  if (!isPlainRecord(value) || !Object.hasOwn(value, segment.key)) return value;
  const result = { ...value };
  const child = value[segment.key];
  switch (segment.kind) {
    case "key": {
      const next = omit(child, rest, [...prefix, segment.key]);
      if (next === absent) delete result[segment.key];
      else result[segment.key] = next;
      break;
    }
    case "item": {
      const entries = resolveLayerMergeRule(LandofileShape, [...prefix, segment.key]).entries(child);
      if (entries !== undefined)
        result[segment.key] = entries.flatMap((item) => {
          const next = itemMatches(item, segment, [...prefix, segment.key])
            ? omit(item, rest, [...prefix, segment.key, 0])
            : item;
          return next === absent ? [] : [next];
        });
      break;
    }
    default:
      return segment satisfies never;
  }
  return result;
};
export const containingUnit = (path: Path): Path => {
  const index = path.findIndex((segment) => segment.kind === "item");
  const segment = path[index];
  return segment === undefined ? path : [...path.slice(0, index), { kind: "key", key: segment.key }];
};
