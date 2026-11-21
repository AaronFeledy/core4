import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  isJsonObject,
  jsonEquals,
  jsonValueKey,
} from "./model.ts";

// Prove only inclusion by preservation of each old arm, possibly with a
// nested widening. Other changes are left to the ordinary classifier.
const preservesValues = (before: JsonValue, after: JsonValue): boolean => {
  if (jsonEquals(before, after)) return true;
  if (!isJsonObject(before) || !isJsonObject(after)) return false;
  if (Object.keys(before).length !== Object.keys(after).length) return false;
  return Object.entries(before).every(([key, oldValue]) => {
    const newValue = after[key];
    if (newValue === undefined) return false;
    if (jsonEquals(oldValue, newValue)) return true;
    switch (key) {
      case "anyOf":
        return (
          Array.isArray(oldValue) &&
          Array.isArray(newValue) &&
          oldValue.every((arm) => newValue.some((candidate) => preservesValues(arm, candidate)))
        );
      case "properties":
        return (
          isJsonObject(oldValue) &&
          isJsonObject(newValue) &&
          Object.keys(oldValue).length === Object.keys(newValue).length &&
          Object.entries(oldValue).every(([name, field]) => {
            const candidate = newValue[name];
            return candidate !== undefined && preservesValues(field, candidate);
          })
        );
      case "items":
      case "additionalProperties":
        return preservesValues(oldValue, newValue);
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
    ? {
        verdict: "compatible",
        changeKind: narrowing ? "union-narrowed" : "union-widened",
        path: `${context.path}.anyOf`,
        message: "A union branch proves the replacement preserves the public contract.",
        accepted: false,
      }
    : undefined;
};

export const compareUnion = (
  before: readonly JsonValue[],
  after: readonly JsonValue[],
  context: { readonly polarity: SchemaPolarity; readonly path: string },
): CompatibilityFinding | undefined => {
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
  return {
    verdict: context.polarity === (narrowed ? "output" : "input") ? "compatible" : "breaking",
    changeKind: `union-${direction}`,
    path: context.path,
    message: `The union was ${direction}.`,
    accepted: false,
  };
};
