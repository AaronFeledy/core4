import { type JsonSchema, type JsonValue, isJsonObject, jsonEquals, jsonValueKey } from "./model.ts";

const scalarChecks = new Set([
  "type",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "enum",
  "const",
]);

const emptySchema = (value: JsonValue | undefined): boolean =>
  value === true || (isJsonObject(value) && Object.keys(value).length === 0);

const jsonTypes = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);

const disjointBranches = (left: JsonValue, right: JsonValue): boolean => {
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  if (typeof left.type === "string" && typeof right.type === "string") {
    const a = left.type === "integer" ? "number" : left.type;
    const b = right.type === "integer" ? "number" : right.type;
    if (jsonTypes.has(a) && jsonTypes.has(b) && a !== b) return true;
  }
  const leftValues = left.const !== undefined ? [left.const] : left.enum;
  const rightValues = right.const !== undefined ? [right.const] : right.enum;
  if (Array.isArray(leftValues) && Array.isArray(rightValues)) {
    return leftValues.every((a) => rightValues.every((b) => !jsonEquals(a, b)));
  }
  if (left.type !== "object" || right.type !== "object") return false;
  const leftProperties = left.properties;
  const rightProperties = right.properties;
  const rightRequired = right.required;
  if (!isJsonObject(leftProperties) || !isJsonObject(rightProperties) || !Array.isArray(rightRequired)) {
    return false;
  }
  return (
    Array.isArray(left.required) &&
    left.required.some((tag) => {
      if (typeof tag !== "string" || !rightRequired.includes(tag)) return false;
      const a = leftProperties[tag];
      const b = rightProperties[tag];
      return (
        isJsonObject(a) &&
        isJsonObject(b) &&
        a.const !== undefined &&
        b.const !== undefined &&
        !jsonEquals(a.const, b.const)
      );
    })
  );
};

/** Canonicalize only identities whose accepted JSON values are unchanged. */
export const normalizeStructure = (schema: JsonSchema, preserveEvaluatedProperties = false): JsonSchema => {
  const result: Record<string, JsonValue> = { ...schema };
  if (Array.isArray(result.items) && result.items.length === 1) {
    const item = result.items[0];
    if (item !== undefined && jsonEquals(item, result.additionalItems)) {
      result.items = item;
      Reflect.deleteProperty(result, "additionalItems");
    }
  }
  for (const key of ["required", "properties", "patternProperties", "dependentSchemas"]) {
    const value = result[key];
    if (
      (Array.isArray(value) && value.length === 0) ||
      (isJsonObject(value) && Object.keys(value).length === 0)
    ) {
      Reflect.deleteProperty(result, key);
    }
  }
  for (const key of ["additionalProperties", "additionalItems", "items"]) {
    if (emptySchema(result[key])) Reflect.deleteProperty(result, key);
  }
  const names = result.propertyNames;
  // JSON object keys are always strings, so this adds no restriction.
  if (emptySchema(names) || (isJsonObject(names) && jsonEquals(names, { type: "string" }))) {
    Reflect.deleteProperty(result, "propertyNames");
  }
  if (typeof result.pattern === "string") {
    // JSON Schema patterns are strings, not slash-delimited regex literals.
    const pattern = result.pattern;
    let canonical = "";
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\" && index + 1 < pattern.length) {
        const escaped = pattern[++index];
        canonical += escaped === "/" ? "/" : `\\${escaped}`;
      } else canonical += char;
    }
    result.pattern = canonical;
  }
  if (Array.isArray(result.items) && result.additionalItems === false) {
    const limit = result.items.length;
    result.maxItems = typeof result.maxItems === "number" ? Math.min(result.maxItems, limit) : limit;
    Reflect.deleteProperty(result, "additionalItems");
  }
  if (
    isJsonObject(result.patternProperties) &&
    result.additionalProperties === undefined &&
    result.unevaluatedProperties === undefined &&
    !preserveEvaluatedProperties
  ) {
    // Pattern matches are conjunctive: deleting a true branch leaves all other
    // matching constraints intact. Unmatched keys still have unrestricted fallback.
    const retained = Object.entries(result.patternProperties).filter(([, child]) => !emptySchema(child));
    if (retained.length === 0) Reflect.deleteProperty(result, "patternProperties");
    else result.patternProperties = Object.fromEntries(retained);
  }
  const patterns = result.patternProperties;
  if (
    isJsonObject(patterns) &&
    Object.keys(patterns).length === 1 &&
    patterns[""] !== undefined &&
    result.properties === undefined
  ) {
    result.additionalProperties = patterns[""];
    Reflect.deleteProperty(result, "patternProperties");
    if (emptySchema(result.additionalProperties)) Reflect.deleteProperty(result, "additionalProperties");
  }
  if (
    isJsonObject(names) &&
    typeof names.pattern === "string" &&
    names.pattern.length > 0 &&
    (names.type === undefined || names.type === "string") &&
    Object.keys(names).every((key) => key === "pattern" || key === "type") &&
    result.properties === undefined &&
    result.patternProperties === undefined &&
    result.unevaluatedProperties === undefined &&
    !preserveEvaluatedProperties
  ) {
    // With no declared keys or other patterns, every allowed key receives the
    // same fallback constraint. Copy the regex verbatim; do not infer its language.
    result.patternProperties = Object.fromEntries([
      [names.pattern, result.additionalProperties === undefined ? {} : result.additionalProperties],
    ]);
    result.additionalProperties = false;
    Reflect.deleteProperty(result, "propertyNames");
  }
  if (Array.isArray(result.type)) {
    const types = result.type;
    Reflect.deleteProperty(result, "type");
    // A type array is a union, intersected with the other sibling constraints.
    result.anyOf = types.map((type) => ({ type }));
    if (schema.anyOf !== undefined) {
      result.allOf = [...(Array.isArray(result.allOf) ? result.allOf : []), { anyOf: schema.anyOf }];
    }
  }
  if (
    Array.isArray(result.oneOf) &&
    result.anyOf === undefined &&
    result.oneOf.every((left, index, branches) =>
      branches.slice(index + 1).every((right) => disjointBranches(left, right)),
    )
  ) {
    result.anyOf = result.oneOf;
    Reflect.deleteProperty(result, "oneOf");
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf.flatMap((child) =>
      isJsonObject(child) && Object.keys(child).length === 1 && Array.isArray(child.anyOf)
        ? child.anyOf
        : [child],
    );
    const hasPlainString = branches.some(
      (child) => isJsonObject(child) && child.type === "string" && Object.keys(child).length === 1,
    );
    const retained = branches.filter(
      (child) =>
        !hasPlainString ||
        !isJsonObject(child) ||
        child.type !== "string" ||
        Object.keys(child).length === 1 ||
        ["$ref", "$dynamicRef", "$recursiveRef"].some((key) => Object.hasOwn(child, key)),
    );
    result.anyOf = [...new Map(retained.map((child) => [jsonValueKey(child), child])).values()].sort((a, b) =>
      jsonValueKey(a).localeCompare(jsonValueKey(b)),
    );
  }
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf.filter((child) => !emptySchema(child));
    Reflect.deleteProperty(result, "allOf");
    const retained: JsonValue[] = [];
    for (const child of branches) {
      if (!isJsonObject(child)) {
        retained.push(child);
        continue;
      }
      // Never move object/array applicators across an allOf scope: in particular,
      // additionalProperties sees only properties declared in its own subschema.
      const keys = Object.keys(child);
      const properties = result.properties;
      const recordIntersection =
        keys.every((key) => key === "type" || key === "additionalProperties") &&
        child.type === "object" &&
        result.type === "object" &&
        child.additionalProperties !== undefined &&
        result.additionalProperties === undefined &&
        result.patternProperties === undefined &&
        isJsonObject(properties) &&
        Object.values(properties).every((property) => jsonEquals(property, child.additionalProperties));
      const canMerge =
        recordIntersection ||
        (Object.keys(result).length === 0 && child.allOf === undefined) ||
        keys.every(
          (key) =>
            scalarChecks.has(key) && (result[key] === undefined || jsonEquals(result[key], child[key])),
        );
      if (canMerge) Object.assign(result, child);
      else retained.push(child);
    }
    if (retained.length > 0) result.allOf = retained;
  }
  if (Array.isArray(result.anyOf) && result.anyOf.length === 1 && Object.keys(result).length === 1) {
    const child = result.anyOf[0];
    if (isJsonObject(child)) return child;
  }
  return result;
};
