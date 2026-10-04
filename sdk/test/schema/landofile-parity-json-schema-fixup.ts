import { expect } from "bun:test";
import { type JsonSchema, Predicate, Schema } from "effect";

const parseOptions = { onExcessProperty: "error", errors: "all" } as const;

// Preserve constraints while lowering JSON Schema forms the Effect importer cannot
// reconstruct: overlapping object intersections, required-key choices, and closed
// extension records. Canonical RegExp.source also avoids its pattern-payload bug.
export function importableNode(node: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  if (typeof node.pattern === "string") {
    const pattern = new RegExp(node.pattern, "u").source;
    if (pattern !== node.pattern) return importableNode({ ...node, pattern });
  }
  if (Array.isArray(node.allOf) && node.allOf.length === 1 && Predicate.isObject(node.properties)) {
    const collapsed = collapseRecordAllOf(node, node.properties, node.allOf[0]);
    if (collapsed !== undefined) return collapsed;
  }
  if (
    Array.isArray(node.anyOf) &&
    node.anyOf.every((entry: unknown) => Predicate.isObject(entry) && Array.isArray(entry.required)) &&
    Predicate.isObject(node.properties)
  ) {
    return importableNode(expandRequiredChoice(node, node.properties, node.anyOf));
  }
  if (
    Array.isArray(node.allOf) &&
    node.allOf.every(
      (entry: unknown) =>
        Predicate.isObject(entry) && Predicate.isObject(entry.not) && Array.isArray(entry.not.required),
    ) &&
    Predicate.isObject(node.properties)
  ) {
    return expandMutualExclusion(node, node.properties, node.allOf);
  }
  if (
    node.additionalProperties === false &&
    Predicate.isObject(node.patternProperties) &&
    Predicate.isObject(node.properties)
  ) {
    return openExtensionRecord(node, node.properties, node.patternProperties);
  }
  if (Predicate.isObject(node.not) && typeof node.not.const === "string") {
    return negateConstLiteral(node, node.not.const);
  }
  return node;
}

function collapseRecordAllOf(
  node: JsonSchema.JsonSchema,
  properties: Record<string, unknown>,
  restSchema: unknown,
): JsonSchema.JsonSchema | undefined {
  if (!Predicate.isObject(restSchema) || !Predicate.isObject(restSchema.additionalProperties))
    return undefined;
  const matchesEveryProperty = Object.values(properties).every(
    (property) => JSON.stringify(property) === JSON.stringify(restSchema.additionalProperties),
  );
  if (!matchesEveryProperty) return undefined;
  expect(Object.keys(restSchema).sort()).toEqual(["additionalProperties", "type"]);
  expect(restSchema.type).toBe("object");
  const { properties: _properties, allOf: _allOf, ...rest } = node;
  return { ...rest, additionalProperties: restSchema.additionalProperties };
}

function expandRequiredChoice(
  node: JsonSchema.JsonSchema,
  properties: Record<string, unknown>,
  anyOf: ReadonlyArray<unknown>,
): JsonSchema.JsonSchema {
  const alternatives = anyOf.map((entry) =>
    Schema.decodeUnknownSync(Schema.Struct({ required: Schema.Array(Schema.String) }))(entry, parseOptions),
  );
  expect(alternatives.every(({ required }) => required.length === 1)).toBe(true);
  expect(alternatives.flatMap(({ required }) => required).sort()).toEqual(Object.keys(properties).sort());
  expect(node.additionalProperties).toBe(false);
  expect(node.patternProperties).toBeUndefined();
  const { anyOf: _anyOf, ...rest } = node;
  return { ...rest, minProperties: Math.max(Number(node.minProperties ?? 0), 1) };
}

function expandMutualExclusion(
  node: JsonSchema.JsonSchema,
  properties: Record<string, unknown>,
  allOf: ReadonlyArray<unknown>,
): JsonSchema.JsonSchema {
  const exclusions = allOf.map(
    (entry) =>
      Schema.decodeUnknownSync(
        Schema.Struct({ not: Schema.Struct({ required: Schema.Array(Schema.String) }) }),
      )(entry, parseOptions).not.required,
  );
  const keys = [...new Set(exclusions.flat())];
  const { allOf: _allOf, ...rest } = node;
  const presentKeySets = Array.from({ length: 2 ** keys.length }, (_, bits) =>
    keys.filter((_key, index) => bits & (1 << index)),
  ).filter((present) => exclusions.every((group) => !group.every((key) => present.includes(key))));
  return {
    anyOf: presentKeySets.map((present) => ({
      ...rest,
      required: [...Schema.decodeUnknownSync(Schema.Array(Schema.String))(node.required ?? []), ...present],
      properties: {
        ...properties,
        ...Object.fromEntries(keys.filter((key) => !present.includes(key)).map((key) => [key, { not: {} }])),
      },
    })),
  };
}

function openExtensionRecord(
  node: JsonSchema.JsonSchema,
  properties: Record<string, unknown>,
  patternProperties: Record<string, unknown>,
): JsonSchema.JsonSchema {
  const patterns = Object.entries(patternProperties);
  for (const [, value] of patterns) {
    expect(Predicate.isObject(value)).toBe(true);
    if (Predicate.isObject(value)) {
      expect(Object.keys(value).filter((key) => !["$id", "title", "description"].includes(key))).toEqual([]);
    }
  }
  const {
    patternProperties: _patternProperties,
    additionalProperties: _additionalProperties,
    propertyNames,
    ...rest
  } = node;
  const allowedNames = {
    anyOf: [{ enum: Object.keys(properties) }, ...patterns.map(([pattern]) => ({ pattern }))],
  };
  return {
    ...rest,
    additionalProperties: true,
    propertyNames: propertyNames ? { allOf: [propertyNames, allowedNames] } : allowedNames,
  };
}

function negateConstLiteral(node: JsonSchema.JsonSchema, literal: string): JsonSchema.JsonSchema {
  if (!Predicate.isObject(node.not)) return node;
  expect(Object.keys(node.not)).toEqual(["const"]);
  expect(node.pattern).toBeUndefined();
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { not: _not, ...rest } = node;
  return { ...rest, pattern: `^(?!${escaped}$)` };
}
