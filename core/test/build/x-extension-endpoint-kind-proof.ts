import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { REVIEWED_WHOLE_EXPRESSION_PATTERN } from "./x-extension-authoring-projection-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const shorthand = {
  type: "string",
  pattern:
    "^(?:([A-Za-z0-9][A-Za-z0-9_-]*)=)?(http|https|tcp|udp):([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])(?![\\s\\S])",
} as const;
const wholeExpression = { type: "string", pattern: REVIEWED_WHOLE_EXPRESSION_PATTERN } as const;

const hasLiteral = (value: JsonValue | undefined, literal: string): boolean =>
  isJsonObject(value) &&
  (jsonEquals(value.enum, [literal]) ||
    (Array.isArray(value.anyOf) && value.anyOf.some((branch) => hasLiteral(branch, literal))));

const endpointVariant = (value: JsonValue): string | undefined => {
  if (!isJsonObject(value) || value.type !== "object" || value.additionalProperties !== false) return;
  const fields = value.properties;
  if (!isJsonObject(fields) || fields.kind !== undefined || fields.protocol === undefined) return;
  if (hasLiteral(fields._tag, "internal")) {
    if (fields.socketPath !== undefined) return "unix";
    if (fields.port !== undefined) return "internal";
  }
  if (hasLiteral(fields._tag, "published") && fields.port !== undefined && fields.publication !== undefined) {
    return "published";
  }
};

const filterFields = {
  stripPrefix: ["prefix"],
  addPrefix: ["prefix"],
  requestHeader: ["header", "value"],
  responseHeader: ["header", "value"],
  redirect: ["to"],
} as const;

export const evolveHistoricalEndpointKind = (historical: JsonSchema, mode: "bare" | "wire"): JsonSchema => {
  const visit = (value: JsonValue, endpointField = false): JsonValue => {
    if (Array.isArray(value)) return value.map((child) => visit(child, endpointField));
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        visit(child, key === "endpoints" || (endpointField && key !== "items")),
      ]),
    );
    const fields = next.properties;
    const discriminator =
      endpointVariant(value) !== undefined
        ? "_tag"
        : value.type === "object" &&
            value.additionalProperties === false &&
            isJsonObject(fields) &&
            fields.kind === undefined &&
            Object.entries(filterFields).some(
              ([literal, keys]) => hasLiteral(fields.type, literal) && keys.every((key) => key in fields),
            )
          ? "type"
          : undefined;
    if (discriminator !== undefined && isJsonObject(fields)) {
      const { [discriminator]: kind, ...rest } = fields;
      if (kind !== undefined) {
        next.properties = { ...rest, kind };
        if (Array.isArray(next.required)) {
          next.required = next.required.map((key) => (key === discriminator ? "kind" : key));
        }
      }
    }

    const oldItems = value.items;
    const items = next.items;
    if (endpointField && value.type === "array" && isJsonObject(oldItems) && isJsonObject(items)) {
      const arms = oldItems.anyOf;
      if (Array.isArray(arms) && Array.isArray(items.anyOf)) {
        const variants = new Set(arms.map(endpointVariant));
        const strings = arms.filter((arm) => isJsonObject(arm) && arm.type === "string");
        if (
          variants.has("internal") &&
          variants.has("published") &&
          variants.has("unix") &&
          (mode === "bare" ? strings.length === 0 : jsonEquals(strings, [wholeExpression]))
        ) {
          // Translator wire describes structure; its validated authoring schema retains refinements.
          // The normalizer absorbs the reviewed whole-expression arm into the new plain string arm.
          next.items = {
            ...items,
            anyOf: [...items.anyOf, mode === "bare" ? shorthand : { type: "string" }],
          };
        }
      }
    }
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
