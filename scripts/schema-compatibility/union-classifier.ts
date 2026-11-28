import { finding } from "./fingerprint.ts";
import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  isJsonObject,
  jsonEquals,
  jsonValueKey,
  stringArray,
} from "./model.ts";

type Preservation = "union-widening" | "optional-properties";

const PLAIN_STRUCT_KEYS = new Set(["additionalProperties", "properties", "required", "type"]);

const propertyNames = (schema: JsonValue): string[] =>
  isJsonObject(schema) && isJsonObject(schema.properties) ? Object.keys(schema.properties) : [];

const isClosedStruct = (schema: JsonValue): boolean =>
  isJsonObject(schema) && schema.type === "object" && schema.additionalProperties === false;

const preservesValues = (
  before: JsonValue,
  after: JsonValue,
  mode: Preservation = "union-widening",
): boolean => {
  if (jsonEquals(before, after)) return true;
  if (!isJsonObject(before) || !isJsonObject(after)) return false;
  if (Object.keys(before).length !== Object.keys(after).length) return false;
  return Object.entries(before).every(([key, oldValue]) => {
    const newValue = after[key];
    if (newValue === undefined) return false;
    if (jsonEquals(oldValue, newValue)) return true;
    switch (key) {
      case "anyOf": {
        if (!Array.isArray(oldValue) || !Array.isArray(newValue)) return false;
        if (mode === "union-widening")
          return oldValue.every((arm) => newValue.some((candidate) => preservesValues(arm, candidate, mode)));
        if (oldValue.length !== newValue.length) return false;
        if (!oldValue.every((arm) => newValue.some((candidate) => preservesValues(arm, candidate, mode))))
          return false;
        // An old value can't carry a key no closed old arm declared, so an optional key that is new
        // to the whole union can't change which arm an old value matches.
        const declared = new Set(oldValue.flatMap(propertyNames));
        const closed = oldValue.every(isClosedStruct);
        for (const arm of newValue) {
          const partner = oldValue.find((candidate) => preservesValues(candidate, arm, mode));
          if (partner === undefined) return false;
          const own = new Set(propertyNames(partner));
          if (propertyNames(arm).some((name) => !own.has(name) && (!closed || declared.has(name))))
            return false;
        }
        return true;
      }
      case "properties": {
        if (!isJsonObject(oldValue) || !isJsonObject(newValue)) return false;
        const added = Object.keys(newValue).filter((name) => !Object.hasOwn(oldValue, name));
        const required = new Set(stringArray(after.required) ?? []);
        // Only closed, plain structs prove the same optional-field addition the ordinary
        // classifier allows. Other constraints may interact with the newly declared key.
        if (
          added.length > 0 &&
          (mode !== "optional-properties" ||
            before.type !== "object" ||
            before.additionalProperties !== false ||
            !Object.keys(before).every((field) => PLAIN_STRUCT_KEYS.has(field)) ||
            added.some((name) => required.has(name)))
        )
          return false;
        return Object.entries(oldValue).every(([name, field]) => {
          const candidate = newValue[name];
          return candidate !== undefined && preservesValues(field, candidate, mode);
        });
      }
      case "items":
      case "additionalProperties":
        return preservesValues(oldValue, newValue, mode);
      default:
        return false;
    }
  });
};

const containsReference = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.some(containsReference)
    : isJsonObject(value) &&
      Object.entries(value).some(
        ([key, child]) => ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) || containsReference(child),
      );

export const compareUnionReplacement = (
  before: JsonSchema,
  after: JsonSchema,
  context: {
    readonly polarity: SchemaPolarity;
    readonly path: string;
    readonly compare: (before: JsonSchema, after: JsonSchema) => ReadonlyArray<CompatibilityFinding>;
  },
): CompatibilityFinding | undefined => {
  const narrowing = context.polarity === "output" && Array.isArray(before.anyOf) && after.anyOf === undefined;
  const widening = context.polarity === "input" && before.anyOf === undefined && Array.isArray(after.anyOf);
  if (!narrowing && !widening) return undefined;
  const wrapper = narrowing ? before : after;
  const members = wrapper.anyOf;
  if (!Array.isArray(members) || Object.keys(wrapper).some((key) => key !== "anyOf")) return undefined;
  const proven = members.some((member) => {
    if (!isJsonObject(member)) return false;
    const oldBranch = narrowing ? member : before;
    const newBranch = narrowing ? after : member;
    return (
      !containsReference(oldBranch) &&
      !containsReference(newBranch) &&
      context.compare(oldBranch, newBranch).every(({ verdict }) => verdict === "compatible")
    );
  });
  return proven
    ? finding(
        "compatible",
        narrowing ? "union-narrowed" : "union-widened",
        `${context.path}.anyOf`,
        "A union branch proves the replacement preserves the public contract.",
        { before, after },
      )
    : undefined;
};

export const compareUnion = (
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  context: { readonly polarity: SchemaPolarity; readonly path: string },
): CompatibilityFinding | undefined => {
  if (preservesValues({ anyOf: before }, { anyOf: after }, "optional-properties")) {
    return finding(
      "compatible",
      "property-added",
      context.path,
      "Only optional properties were added inside the union members.",
      { before, after },
    );
  }
  if (context.polarity === "strict") return undefined;
  const beforeKeys = new Set(before.map(jsonValueKey));
  const afterKeys = new Set(after.map(jsonValueKey));
  const widened = beforeKeys.size < afterKeys.size && [...beforeKeys].every((key) => afterKeys.has(key));
  const narrowed = afterKeys.size < beforeKeys.size && [...afterKeys].every((key) => beforeKeys.has(key));
  const nestedWidening =
    !widened &&
    !narrowed &&
    before.every((arm) => after.some((candidate) => preservesValues(arm, candidate)));
  if (!widened && !narrowed && !nestedWidening) return undefined;
  const direction = narrowed ? "narrowed" : "widened";
  return finding(
    context.polarity === (narrowed ? "output" : "input") ? "compatible" : "breaking",
    `union-${direction}`,
    context.path,
    `The union was ${direction}.`,
    { before, after },
  );
};
