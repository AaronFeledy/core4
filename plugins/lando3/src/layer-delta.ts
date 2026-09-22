import type { ConfigTranslateSourceId, LandofileLayer } from "@lando/sdk/schema";
import {
  identityKeyFor,
  isPlainRecord,
  mergeLandofiles,
  mergeValues,
  routeFilterIdentity,
  routeFilterMatches,
} from "./v4-merge.ts";

export type UnitSegment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "item"; readonly key: string; readonly identityKey: string; readonly identity: string };
export interface DesiredPrefix {
  readonly layer: LandofileLayer;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  /** Complete config that must be in force after this layer merges. */
  readonly desired: Readonly<Record<string, unknown>>;
}
export interface Relocation {
  readonly unitPath: ReadonlyArray<UnitSegment>;
  readonly hoistedTo: LandofileLayer;
  readonly omittedFrom: ReadonlyArray<LandofileLayer>;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly changedPrefixes: ReadonlyArray<LandofileLayer>;
}
export interface LayerDeltaResult {
  readonly emitted: ReadonlyArray<{
    readonly layer: LandofileLayer;
    readonly fragment: Readonly<Record<string, unknown>>;
  }>;
  readonly relocations: ReadonlyArray<Relocation>;
}
type Path = ReadonlyArray<UnitSegment>;
const unchanged = Symbol("unchanged");
const absent = Symbol("absent");

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, i) => equal(value, right[i]));
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
};
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
};
const record = (value: unknown): Record<string, unknown> => {
  if (!isPlainRecord(value)) throw new Error("Layer delta must be a record");
  return value;
};
const itemMatches = (item: unknown, segment: Extract<UnitSegment, { kind: "item" }>): boolean =>
  isPlainRecord(item) &&
  (segment.key === "filters"
    ? routeFilterMatches(item, { [segment.identityKey]: segment.identity })
    : item[segment.identityKey] === segment.identity);

const atPath = (value: unknown, path: Path): unknown => {
  const [segment, ...rest] = path;
  if (segment === undefined) return value;
  if (!isPlainRecord(value) || !Object.hasOwn(value, segment.key)) return absent;
  const child = value[segment.key];
  switch (segment.kind) {
    case "key":
      return atPath(child, rest);
    case "item": {
      const item: unknown = Array.isArray(child)
        ? child.find((entry) => itemMatches(entry, segment))
        : undefined;
      return item === undefined ? absent : atPath(item, rest);
    }
    default:
      return segment satisfies never;
  }
};
const omit = (value: unknown, path: Path): unknown => {
  const [segment, ...rest] = path;
  if (segment === undefined) return absent;
  if (!isPlainRecord(value) || !Object.hasOwn(value, segment.key)) return value;
  const result = { ...value };
  const child = value[segment.key];
  switch (segment.kind) {
    case "key": {
      const next = omit(child, rest);
      if (next === absent) delete result[segment.key];
      else result[segment.key] = next;
      break;
    }
    case "item":
      if (Array.isArray(child))
        result[segment.key] = child.flatMap((item) => {
          const next = itemMatches(item, segment) ? omit(item, rest) : item;
          return next === absent ? [] : [next];
        });
      break;
    default:
      return segment satisfies never;
  }
  return result;
};
const containingUnit = (path: Path): Path => {
  const index = path.findIndex((segment) => segment.kind === "item");
  const segment = path[index];
  return segment === undefined ? path : [...path.slice(0, index), { kind: "key", key: segment.key }];
};
interface DeltaContext {
  readonly path: Path;
  readonly removals: Path[];
}
const delta = (left: unknown, right: unknown, context: DeltaContext): unknown => {
  if (equal(left, right)) return unchanged;
  const { path, removals } = context;
  if (Array.isArray(left) && Array.isArray(right)) {
    const key = path.at(-1)?.key;
    if (!left.every(isPlainRecord) || !right.every(isPlainRecord)) return right;
    const identity = (item: Record<string, unknown>) =>
      key === "filters" ? routeFilterIdentity(item)?.kind : identityKeyFor(item);
    if ([...left, ...right].some((item) => identity(item) === undefined)) return right;
    const matches = (candidate: Record<string, unknown>, item: Record<string, unknown>) => {
      const id = identity(item);
      return key === "filters"
        ? routeFilterMatches(candidate, item)
        : id !== undefined && candidate[id] === item[id];
    };
    const itemPath = (item: Record<string, unknown>): Path => {
      const id = identity(item);
      if (key === undefined || id === undefined || typeof item[id] !== "string") return containingUnit(path);
      return [...path.slice(0, -1), { kind: "item", key, identityKey: id, identity: item[id] }];
    };
    const collides = (items: readonly Record<string, unknown>[]) =>
      items.some((item, index) =>
        items.slice(index + 1).some((other) => matches(item, other) || matches(other, item)),
      );
    const arrayRemovals: Path[] = [];
    const ambiguous =
      collides(left) ||
      collides(right) ||
      right.some((item) => {
        const previous = left.find((candidate) => matches(candidate, item));
        return previous !== undefined && identity(previous) !== identity(item);
      });
    const changes = right.filter((item) => {
      const previous = left.find((candidate) => matches(candidate, item));
      if (previous === undefined) return true;
      // Type-changing filters replace rather than merge their old fields.
      if (
        key === "filters" &&
        typeof previous.type === "string" &&
        typeof item.type === "string" &&
        previous.type !== item.type
      )
        return true;
      return delta(previous, item, { path: itemPath(item), removals: arrayRemovals }) !== unchanged;
    });
    // Replay owns representability; hoisting any child must preserve the entire
    // outer array because keyed merge updates in place and only appends new items.
    if (ambiguous || arrayRemovals.length > 0 || !equal(mergeValues(left, changes, key), right))
      removals.push(containingUnit(path));
    return changes.length === 0 ? unchanged : changes;
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return right;
  for (const key of Object.keys(left).sort())
    if (!Object.hasOwn(right, key)) {
      const ownPath: Path = [...path, { kind: "key", key }];
      removals.push(containingUnit(isPlainRecord(left[key]) || path.length === 0 ? ownPath : path));
    }
  const fragment: Record<string, unknown> = {};
  for (const key of Object.keys(right).sort()) {
    const value = Object.hasOwn(left, key)
      ? delta(left[key], right[key], { path: [...path, { kind: "key", key }], removals })
      : right[key];
    if (value !== unchanged) fragment[key] = value;
  }
  if (!equal(mergeValues(left, fragment), right) && removals.length === 0) {
    if (path.length > 0) removals.push(containingUnit(path));
    else {
      const replayed = record(mergeValues(left, fragment));
      const key = [...new Set([...Object.keys(left), ...Object.keys(right)])]
        .sort()
        .find(
          (key) =>
            Object.hasOwn(replayed, key) !== Object.hasOwn(right, key) || !equal(replayed[key], right[key]),
        );
      if (key !== undefined) removals.push([{ kind: "key", key }]);
    }
  }
  return Object.keys(fragment).length === 0 ? unchanged : fragment;
};

export const planLayerDeltas = (prefixes: ReadonlyArray<DesiredPrefix>): LayerDeltaResult => {
  const relocations: Relocation[] = [];
  const masks: { readonly path: Path; readonly before: number }[] = [];
  const distinctUnits = new Set<string>();
  let previous: Record<string, unknown>[] = [];
  let iterations = 0;
  // Failed item replays coarsen to the outer array, then a containing map key:
  // escalation only reaches strict ancestors. A unit's omission frontier only
  // moves to higher layers; masks never shrink. Finite paths and layers permit
  // at most N * U restarts, plus two passes to confirm the fixed point.
  for (;;) {
    const fragments: Record<string, unknown>[] = [];
    let restart = false;
    for (const [index, prefix] of prefixes.entries()) {
      const desired = masks.reduce<unknown>(
        (value, mask) => (index < mask.before ? omit(value, mask.path) : value),
        prefix.desired,
      );
      const removals: Path[] = [];
      const accumulated = mergeLandofiles(fragments);
      const fragment = delta(accumulated, desired, { path: [], removals });
      const unit = removals[0];
      if (unit !== undefined) {
        const name = JSON.stringify(unit);
        distinctUnits.add(name);
        if (
          masks.some((mask) => mask.before >= index && equal(mask.path, unit)) ||
          ++iterations > prefixes.length * distinctUnits.size
        )
          throw new Error(`Layer delta fixpoint exceeded for unit ${name}`);
        const deleted = fragments.map((value) => record(omit(value, unit)));
        const omittedFrom = prefixes
          .slice(0, index)
          .filter((_, j) => !equal(fragments[j], deleted[j]))
          .map(({ layer }) => layer);
        const changedPrefixes = prefixes
          .slice(0, index)
          .filter(
            (_, j) =>
              !equal(
                atPath(mergeLandofiles(fragments.slice(0, j + 1)), unit),
                atPath(mergeLandofiles(deleted.slice(0, j + 1)), unit),
              ),
          )
          .map(({ layer }) => layer);
        const sourceIds = [
          ...new Set(
            prefixes
              .slice(0, index + 1)
              .filter((entry, j) => j === index || omittedFrom.includes(entry.layer))
              .flatMap(({ sourceIds }) => sourceIds),
          ),
        ];
        relocations.push({
          unitPath: unit,
          hoistedTo: prefix.layer,
          omittedFrom,
          changedPrefixes,
          sourceIds,
        });
        masks.push({ path: unit, before: index });
        restart = true;
        break;
      }
      const candidate = fragment === unchanged ? {} : record(sorted(fragment));
      if (!equal(mergeValues(accumulated, candidate), desired))
        throw new Error(`Layer delta replay failed at ${prefix.layer}`);
      fragments.push(candidate);
    }
    if (restart) continue;
    if (!equal(previous, fragments)) {
      previous = fragments;
      continue;
    }
    if (!equal(mergeLandofiles(fragments), prefixes.at(-1)?.desired ?? {}))
      throw new Error("Layer delta final desired postcondition failed");
    return {
      emitted: prefixes.map(({ layer }, index) => ({ layer, fragment: fragments[index] ?? {} })),
      relocations,
    };
  }
};
