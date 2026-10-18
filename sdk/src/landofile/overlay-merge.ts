import type { Schema } from "effect";
import { LandofileShape } from "../schema/landofile.ts";
import { resolveLayerMergeRule } from "./layer-merge-rules.ts";
import { isLandofileOverride, isLandofileReset } from "./merge-directives.ts";
import type { ValueOrigins, ValueWithOrigins } from "./overlay-origins.ts";
import { isPlainRecord } from "./record.ts";

export { isPlainRecord } from "./record.ts";
export { routeFilterIdentity, routeFilterMatches, type RouteFilterIdentity } from "./layer-merge-rules.ts";

const ABSENT = Symbol("absent");
const untracked: ValueOrigins<undefined> = { source: undefined, deleted: false, children: new Map() };

class OverlayMerge<Source> {
  constructor(
    readonly root: Schema.Top,
    readonly tracked: boolean,
  ) {}

  child(node: ValueWithOrigins<Source>, key: string | number, value: unknown): ValueWithOrigins<Source> {
    return { value, origins: (this.tracked ? node.origins.children.get(key) : undefined) ?? node.origins };
  }

  result(
    node: ValueWithOrigins<Source>,
    value: unknown,
    children?: ReadonlyMap<string | number, ValueOrigins<Source>>,
  ): ValueWithOrigins<Source> {
    return {
      value,
      origins: this.tracked
        ? { source: node.origins.source, deleted: value === ABSENT, children: children ?? new Map() }
        : node.origins,
    };
  }

  materialize(node: ValueWithOrigins<Source>): ValueWithOrigins<Source> {
    const value = node.value;
    if (isLandofileReset(value)) return this.result(node, ABSENT);
    if (isLandofileOverride(value)) return this.materialize({ ...node, value: value.value });
    const children = this.tracked ? new Map<string | number, ValueOrigins<Source>>() : undefined;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      value.forEach((entry, index) => {
        const child = this.materialize(this.child(node, index, entry));
        children?.set(result.length, child.origins);
        if (child.value !== ABSENT) result.push(child.value);
      });
      return this.result(node, result, children);
    }
    if (!isPlainRecord(value)) return node;
    const result = Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const child = this.materialize(this.child(node, key, entry));
        children?.set(key, child.origins);
        return child.value === ABSENT ? [] : [[key, child.value]];
      }),
    );
    if (children !== undefined) {
      for (const [key, origin] of node.origins.children) {
        if (origin.deleted && !children.has(key)) children.set(key, origin);
      }
    }
    return this.result(node, result, children);
  }

  merge(
    left: ValueWithOrigins<Source>,
    right: ValueWithOrigins<Source>,
    path: readonly (string | number)[],
  ): ValueWithOrigins<Source> {
    if (isLandofileReset(right.value) || isLandofileOverride(right.value)) return this.materialize(right);
    const rule = resolveLayerMergeRule(this.root, path);
    if (Array.isArray(right.value) && right.value.length === 0) return this.materialize(right);
    if (rule.descriptor.kind === "keyed") {
      const project = (node: ValueWithOrigins<Source>) => {
        const values = rule.entries(node.value);
        if (values === undefined) return undefined;
        if (!this.tracked) return values.map((value) => ({ value, origins: node.origins }));
        const sources = Array.isArray(node.value)
          ? node.value.flatMap((entry, index) => rule.parts(entry).map(() => this.child(node, index, entry)))
          : isPlainRecord(node.value)
            ? Object.entries(node.value).map(([key, entry]) => this.child(node, key, entry))
            : [];
        return values.map((value, index) => ({ value, origins: (sources[index] ?? node).origins }));
      };
      const base = project(left);
      const overlay = project(right);
      if (base !== undefined && overlay !== undefined) {
        const baseKeys = base.map((node) => rule.key(node.value));
        const overlayKeys = overlay.map((node) => rule.key(node.value));
        if (baseKeys.includes(undefined) || overlayKeys.includes(undefined)) return this.materialize(right);
        const mergeEntry = (
          item: ValueWithOrigins<Source>,
          higher: ValueWithOrigins<Source>,
          index: number,
        ) => {
          if (
            rule.descriptor.kind === "keyed" &&
            rule.descriptor.onMatch === "replace-on-type-change" &&
            isPlainRecord(item.value) &&
            isPlainRecord(higher.value) &&
            typeof item.value.type === "string" &&
            typeof higher.value.type === "string" &&
            item.value.type !== higher.value.type
          )
            return this.materialize(higher);
          return this.merge(
            { ...item, value: rule.matched(item.value) },
            { ...higher, value: rule.matched(higher.value) },
            [...path, index],
          );
        };
        let merged: ValueWithOrigins<Source>[] | undefined;
        if (!rule.preserveDuplicates) {
          merged = [...base];
          for (const higher of overlay) {
            const index = merged.findIndex((item) => rule.key(item.value) === rule.key(higher.value));
            const item = merged[index];
            if (item === undefined) merged.push(this.materialize(higher));
            else merged[index] = mergeEntry(item, higher, index);
          }
        } else if (Array.isArray(left.value) && Array.isArray(right.value)) {
          const consumed = new Set<number>();
          const retained = left.value.flatMap((original, index) => {
            const originalNode = this.child(left, index, original);
            let matched = false;
            const parts = rule.parts(original).map((value) => {
              const item = { ...originalNode, value };
              const match = overlayKeys.findIndex((key, i) => key === rule.key(value) && !consumed.has(i));
              const higher = overlay[match];
              if (higher === undefined) return item;
              matched = true;
              consumed.add(match);
              return mergeEntry(item, higher, index);
            });
            return matched ? parts : [originalNode];
          });
          let offset = 0;
          const appended = right.value.flatMap((original, index) => {
            const originalNode = this.child(right, index, original);
            const parts = rule.parts(original);
            const unmatched = parts.filter((_, partIndex) => !consumed.has(offset + partIndex));
            offset += parts.length;
            return unmatched.length === parts.length
              ? [originalNode]
              : unmatched.map((value) => ({ ...originalNode, value }));
          });
          merged = [...retained, ...appended.map((node) => this.materialize(node))];
        }
        if (merged !== undefined)
          return this.result(
            right,
            merged.map((node) => node.value),
            this.tracked ? new Map(merged.map((node, index) => [index, node.origins])) : undefined,
          );
      }
    }
    if (!isPlainRecord(left.value) || !isPlainRecord(right.value)) return this.materialize(right);
    const result: Record<string, unknown> = { ...left.value };
    const children = this.tracked ? new Map(left.origins.children) : undefined;
    for (const [key, value] of Object.entries(right.value)) {
      const merged = this.merge(this.child(left, key, left.value[key]), this.child(right, key, value), [
        ...path,
        key,
      ]);
      children?.set(key, merged.origins);
      if (merged.value === ABSENT) delete result[key];
      else
        Object.defineProperty(result, key, {
          value: merged.value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    return this.result(right, result, children);
  }
}

export const mergeValues = (
  root: Schema.Top,
  left: unknown,
  right: unknown,
  path: ReadonlyArray<string | number> = [],
): unknown => {
  const merger = new OverlayMerge<undefined>(root, false);
  const result = merger.merge(
    merger.materialize({ value: left, origins: untracked }),
    { value: right, origins: untracked },
    path,
  );
  return result.value === ABSENT ? undefined : result.value;
};

/** Merge values and origins together; never infer attribution by comparing output values. */
export const mergeValuesWithOrigins = <Source>(
  root: Schema.Top,
  left: ValueWithOrigins<Source>,
  right: ValueWithOrigins<Source>,
): ValueWithOrigins<Source> => {
  const merger = new OverlayMerge<Source>(root, true);
  const result = merger.merge(merger.materialize(left), right, []);
  return { ...result, value: result.value === ABSENT ? undefined : result.value };
};

/** Fold Landofile fragments from lowest to highest precedence; validation belongs to the caller. */
export const mergeLandofiles = (layers: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> =>
  layers.reduce<Record<string, unknown>>((left, right) => {
    const merged = mergeValues(LandofileShape, left, right);
    return isPlainRecord(merged) ? merged : {};
  }, {});
