import { isLandofileOverride, isLandofileReset } from "./merge-directives.ts";
import { isPlainRecord } from "./record.ts";

export interface ValueOrigins<Source> {
  readonly source: Source;
  readonly deleted: boolean;
  /** A consumed directive or form change replaced this subtree during composition. */
  readonly replaced?: true;
  readonly children: ReadonlyMap<string | number, ValueOrigins<Source>>;
}

export interface ValueWithOrigins<Source> {
  readonly value: unknown;
  readonly origins: ValueOrigins<Source>;
}

/** Capture authored paths before projections, aliases, or keyed-list relocation change them. */
export const withValueOrigins = <Source>(
  value: unknown,
  source: (path: readonly (string | number)[]) => Source,
): ValueWithOrigins<Source> => {
  const visit = (input: unknown, path: readonly (string | number)[]): ValueOrigins<Source> => {
    const plain = isLandofileOverride(input) ? input.value : input;
    const children = new Map<string | number, ValueOrigins<Source>>();
    if (Array.isArray(plain)) {
      plain.forEach((entry, index) => children.set(index, visit(entry, [...path, index])));
    } else if (isPlainRecord(plain) && !isLandofileReset(plain)) {
      for (const [key, entry] of Object.entries(plain)) children.set(key, visit(entry, [...path, key]));
    }
    return {
      source: source(path),
      deleted: isLandofileReset(input),
      ...(isLandofileOverride(input) || isLandofileReset(input) ? { replaced: true as const } : {}),
      children,
    };
  };
  return { value, origins: visit(value, []) };
};

/** Missing/generated fields inherit their nearest authored ancestor's location. */
export const valueOriginAt = <Source>(
  origins: ValueOrigins<Source>,
  path: readonly (string | number)[],
): ValueOrigins<Source> => {
  let current = origins;
  for (const key of path) {
    const next = current.children.get(key);
    if (next === undefined) break;
    current = next;
  }
  return current;
};
