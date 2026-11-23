import { finding } from "./fingerprint.ts";
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

  const change = { before, after };
  if (widened) {
    return finding(
      context.polarity === "input" ? "compatible" : "breaking",
      "enum-widened",
      context.path,
      "The accepted value set was widened.",
      change,
    );
  }
  if (narrowed) {
    return finding(
      context.polarity === "output" ? "compatible" : "breaking",
      "enum-narrowed",
      context.path,
      "The accepted value set was narrowed.",
      change,
    );
  }
  return finding(
    "breaking",
    "enum-changed",
    context.path,
    "The accepted value set changed incompatibly.",
    change,
  );
};
