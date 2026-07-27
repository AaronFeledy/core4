import type { CompatibilityFinding, JsonValue, SchemaPolarity } from "./model.ts";
import { jsonValueKey } from "./model.ts";

interface EnumComparisonContext {
  readonly polarity: SchemaPolarity;
  readonly path: string;
}

export const compareEnum = (
  before: ReadonlyArray<JsonValue>,
  after: ReadonlyArray<JsonValue>,
  context: EnumComparisonContext,
): CompatibilityFinding => {
  const beforeKeys = new Set(before.map(jsonValueKey));
  const afterKeys = new Set(after.map(jsonValueKey));
  const widened = beforeKeys.size < afterKeys.size && [...beforeKeys].every((key) => afterKeys.has(key));
  const narrowed = afterKeys.size < beforeKeys.size && [...afterKeys].every((key) => beforeKeys.has(key));

  if (widened) {
    return {
      verdict: context.polarity === "input" ? "compatible" : "breaking",
      changeKind: "enum-widened",
      path: context.path,
      message: "The accepted value set was widened.",
      accepted: false,
    };
  }
  if (narrowed) {
    return {
      verdict: context.polarity === "output" ? "compatible" : "breaking",
      changeKind: "enum-narrowed",
      path: context.path,
      message: "The accepted value set was narrowed.",
      accepted: false,
    };
  }
  return {
    verdict: "breaking",
    changeKind: "enum-changed",
    path: context.path,
    message: "The accepted value set changed incompatibly.",
    accepted: false,
  };
};
