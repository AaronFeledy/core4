import type { CompatibilityException } from "../../../scripts/schema-compatibility/classifier.ts";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { CLOSED_EXTENSION_JUSTIFICATION } from "./x-extension-closed-record.ts";

export const WIRE_TARGETS = [
  ["ConfigTranslateDocumentSetInput", "$.currentLowerV4Fragments.items.fragment", "fragment"],
  ["ConfigTranslateEncodeInput", "$.context.services", "services"],
  ["ConfigTranslateEncodeInput", "$.fragment", "fragment"],
  ["ConfigTranslateInput", "$", "input"],
  ["ConfigTranslateLayerFragment", "$.fragment", "fragment"],
  ["ConfigTranslateOutput", "$.fragment", "fragment"],
  ["ConfigTranslateResult", "$.outputs.items.fragment", "fragment"],
  ["RecipeDecomposeResult", "$.fragment", "fragment"],
] as const;

export const expectedWireExceptions = (): readonly CompatibilityException[] =>
  WIRE_TARGETS.map(([id, path]) => ({
    surface: `schema:${id}`,
    changeKind: "unsupported-construct",
    path: `${path}.anyOf`,
    justification: CLOSED_EXTENSION_JUSTIFICATION,
  }));

export const wireObject = (value: unknown): JsonSchema => {
  if (!isJsonObject(value)) throw new Error("Expected captured wire schema object");
  return value;
};

export const atWirePath = (schema: JsonSchema, path: string): JsonSchema =>
  path
    .split(".")
    .slice(1)
    .reverse()
    .reduce<JsonSchema>(
      (child, key) =>
        key === "items" ? { type: "array", items: child } : { type: "object", properties: { [key]: child } },
      schema,
    );

export const tightenWireString = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const changed = tightenWireString(child);
      if (changed !== child) return value.map((entry, i) => (i === index ? changed : entry));
    }
  } else if (isJsonObject(value)) {
    if (value.type === "string") return { ...value, minLength: 999 };
    for (const [key, child] of Object.entries(value)) {
      const changed = tightenWireString(child);
      if (changed !== child) return { ...value, [key]: changed };
    }
  }
  return value;
};
