import { type CompatibilityFinding, type JsonValue, type SchemaPolarity, jsonValueKey } from "./model.ts";

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
