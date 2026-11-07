import {
  type CompatibilityFinding,
  type JsonSchema,
  type JsonValue,
  type SchemaPolarity,
  isJsonObject,
  jsonValueKey,
} from "./model.ts";

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
  if (!widened && !narrowed) return undefined;
  return {
    verdict: context.polarity === (widened ? "input" : "output") ? "compatible" : "breaking",
    changeKind: widened ? "union-widened" : "union-narrowed",
    path: context.path,
    message: `The union member set was ${widened ? "widened" : "narrowed"}.`,
    accepted: false,
  };
};
