import { finding } from "./fingerprint.ts";
import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  childPath,
  isJsonObject,
  jsonEquals,
  jsonValueKey,
} from "./model.ts";

interface SetChange {
  readonly kind: "enum" | "union";
  readonly direction: "widened" | "narrowed";
  readonly path: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}

export const setFinding = (
  change: SetChange,
  policy: { readonly polarity: SchemaPolarity; readonly persisted?: boolean },
): CompatibilityFinding => {
  const { kind, direction, path } = change;
  const { polarity, persisted } = policy;
  const compatible = polarity === (direction === "widened" ? "input" : "output");
  const entry = finding(
    persisted && direction === "narrowed"
      ? "breaking"
      : compatible
        ? "compatible"
        : polarity === "strict"
          ? "unknown"
          : "breaking",
    `${kind}-${direction}`,
    path,
    `The ${kind === "enum" ? "literal value set" : "union"} was ${direction}.`,
    change,
  );
  return persisted && direction === "widened"
    ? { ...entry, persistedWidening: compatible ? "version-only" : "review" }
    : entry;
};

const isSubset = (subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean =>
  [...subset].every((key) => superset.has(key));

const setChange = (
  change: Omit<SetChange, "direction">,
  values: {
    readonly before: readonly JsonValue[];
    readonly after: readonly JsonValue[];
  },
): readonly SetChange[] | undefined => {
  const oldKeys = new Set(values.before.map(jsonValueKey));
  const newKeys = new Set(values.after.map(jsonValueKey));
  if (isSubset(oldKeys, newKeys))
    return oldKeys.size === newKeys.size ? [] : [{ ...change, direction: "widened" }];
  if (isSubset(newKeys, oldKeys)) return [{ ...change, direction: "narrowed" }];
  return undefined;
};

const literalMatchesType = (value: JsonValue, type: JsonValue | undefined): boolean => {
  if (type === undefined) return true;
  if (value === null) return type === "null";
  if (Array.isArray(value)) return type === "array";
  if (typeof value === "number") return type === "number" || (type === "integer" && Number.isInteger(value));
  return type === typeof value;
};

const literalValues = (schema: JsonValue): readonly JsonValue[] | undefined => {
  if (!isJsonObject(schema)) return undefined;
  const { const: value, enum: members, anyOf, type } = schema;
  const keys = Object.keys(schema);
  if (keys.length === 1 && Array.isArray(anyOf)) {
    const values: JsonValue[] = [];
    for (const arm of anyOf) {
      const literals = literalValues(arm);
      if (literals === undefined) return undefined;
      values.push(...literals);
    }
    return values;
  }
  const keyword = value === undefined ? "enum" : "const";
  if (keys.some((key) => key !== keyword && key !== "type")) return undefined;
  const values = value === undefined ? members : [value];
  return Array.isArray(values) && values.every((literal) => literalMatchesType(literal, type))
    ? values
    : undefined;
};

const literalChange = (
  before: JsonSchema,
  after: JsonSchema,
  path: string,
): readonly SetChange[] | undefined => {
  const oldValues = literalValues(before);
  const newValues = literalValues(after);
  if (oldValues === undefined || newValues === undefined) return undefined;
  const union = before.anyOf !== undefined || after.anyOf !== undefined;
  return setChange(
    {
      kind: union ? "union" : "enum",
      path: union ? childPath(path, "anyOf") : path,
      before: union ? (before.anyOf ?? before) : (before.enum ?? before),
      after: union ? (after.anyOf ?? after) : (after.enum ?? after),
    },
    { before: oldValues, after: newValues },
  );
};

export const hasProofBarrier = (schema: JsonSchema): boolean =>
  ["$ref", "$dynamicRef", "$recursiveRef", "unevaluatedItems", "unevaluatedProperties"].some((key) =>
    Object.hasOwn(schema, key),
  );

export const proofBarrier = (schema: JsonValue): boolean =>
  Array.isArray(schema)
    ? schema.some(proofBarrier)
    : isJsonObject(schema) &&
      (hasProofBarrier(schema) ||
        Object.entries(schema).some(([key, child]) =>
          key === "properties" || key === "patternProperties" || key === "dependentSchemas"
            ? isJsonObject(child) && Object.values(child).some(proofBarrier)
            : key !== "enum" && key !== "const" && proofBarrier(child),
        ));

const uniform = (changes: readonly SetChange[]): readonly SetChange[] | undefined =>
  changes.every(({ direction }) => direction === changes[0]?.direction) ? changes : undefined;

const partition = (arms: readonly JsonValue[]) => {
  const literals: JsonValue[] = [];
  const structural: { readonly arm: JsonValue; readonly index: number }[] = [];
  for (const [index, arm] of arms.entries()) {
    const values = literalValues(arm);
    if (values === undefined) structural.push({ arm, index });
    else literals.push(...values);
  }
  return { literals, structural };
};

export const exactUnionChange = (
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
): readonly SetChange[] | undefined => setChange({ kind: "union", path, before, after }, { before, after });

const proveUnion = (
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  path: string,
): readonly SetChange[] | undefined => {
  const change = { kind: "union", path, before, after } as const;
  const oldArms = partition(before);
  const newArms = partition(after);
  const literals = setChange(change, { before: oldArms.literals, after: newArms.literals });
  if (literals === undefined) return undefined;
  const oldStructural = oldArms.structural.map(({ arm }) => arm);
  const newStructural = newArms.structural.map(({ arm }) => arm);
  const exact = setChange(change, { before: oldStructural, after: newStructural });
  if (exact !== undefined) return uniform([...literals, ...exact]);

  const oldKeys = new Set(oldStructural.map(jsonValueKey));
  const newKeys = new Set(newStructural.map(jsonValueKey));
  const removed = oldArms.structural.filter(({ arm }) => !newKeys.has(jsonValueKey(arm)));
  const added = newStructural.filter((arm) => !oldKeys.has(jsonValueKey(arm)));
  if (removed.length !== added.length) return undefined;

  // Pair structurally preserved arms, not their positions after normalization sorts them.
  const matched = new Set<number>();
  const changes: SetChange[] = [...literals];
  for (const { arm, index } of removed) {
    const candidates = added.flatMap((candidate, newIndex) => {
      const proof = prove(arm, candidate, `${path}[${index}]`);
      return proof === undefined ? [] : [{ newIndex, proof }];
    });
    const [candidate] = candidates;
    if (candidate === undefined || candidates.length !== 1 || matched.has(candidate.newIndex))
      return undefined;
    matched.add(candidate.newIndex);
    changes.push(...candidate.proof);
  }
  return uniform(changes);
};

const prove = (before: JsonValue, after: JsonValue, path: string): readonly SetChange[] | undefined => {
  if (jsonEquals(before, after)) return [];
  if (!isJsonObject(before) || !isJsonObject(after)) return undefined;
  const literals = literalChange(before, after, path);
  if (literals !== undefined) return literals;
  const unionPath = childPath(path, "anyOf");
  if (
    before.anyOf === undefined &&
    Object.keys(after).length === 1 &&
    Array.isArray(after.anyOf) &&
    after.anyOf.some((arm) =>
      prove(before, arm, unionPath)?.every(({ direction }) => direction === "widened"),
    )
  ) {
    return [{ kind: "union", path: unionPath, direction: "widened", before, after }];
  }
  if (
    after.anyOf === undefined &&
    Object.keys(before).length === 1 &&
    Array.isArray(before.anyOf) &&
    before.anyOf.some((arm) =>
      prove(arm, after, unionPath)?.every(({ direction }) => direction === "narrowed"),
    )
  ) {
    return [{ kind: "union", path: unionPath, direction: "narrowed", before, after }];
  }
  if (Object.keys(before).length !== Object.keys(after).length) return undefined;

  const changes: SetChange[] = [];
  for (const [key, oldValue] of Object.entries(before)) {
    if (!Object.hasOwn(after, key)) return undefined;
    const newValue = after[key];
    if (newValue === undefined) return undefined;
    if (jsonEquals(oldValue, newValue)) continue;
    const nestedPath = childPath(path, key);
    if (key === "properties" && isJsonObject(oldValue) && isJsonObject(newValue)) {
      if (Object.keys(oldValue).length !== Object.keys(newValue).length) return undefined;
      for (const [name, oldProperty] of Object.entries(oldValue)) {
        if (!Object.hasOwn(newValue, name)) return undefined;
        const newProperty = newValue[name];
        if (newProperty === undefined) return undefined;
        const proof = prove(oldProperty, newProperty, childPath(path, name));
        if (proof === undefined) return undefined;
        changes.push(...proof);
      }
      continue;
    }
    let proof: readonly SetChange[] | undefined;
    if (key === "anyOf" && Array.isArray(oldValue) && Array.isArray(newValue)) {
      proof = proveUnion(oldValue, newValue, nestedPath);
    } else if (key === "items" || key === "additionalProperties") {
      proof = prove(oldValue, newValue, nestedPath);
    }
    if (proof === undefined) return undefined;
    changes.push(...proof);
  }
  return uniform(changes);
};

/** Inclusion through positive schema positions only, with all other constraints unchanged. */
export const proveSetChange = (
  before: JsonSchema,
  after: JsonSchema,
  path: string,
): readonly SetChange[] | undefined =>
  proofBarrier(before) || proofBarrier(after) ? undefined : prove(before, after, path);
