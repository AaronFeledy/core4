import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { TYPED_EXPRESSION_PATTERN, wireObject } from "./x-extension-wire-proof.ts";

/** Normalized SqliteTargetConfig object: path is a plain string in every projection. */
const SQLITE_OBJECT: JsonSchema = {
  additionalProperties: false,
  properties: { path: { type: "string" } },
  required: ["path"],
  type: "object",
};

const EXPRESSION: JsonSchema = {
  pattern: TYPED_EXPRESSION_PATTERN,
  type: "string",
};

const OVERRIDE_STRING: JsonSchema = {
  additionalProperties: false,
  properties: {
    _tag: { enum: ["LandofileOverride"], type: "string" },
    value: { type: "string" },
  },
  required: ["_tag", "value"],
  type: "object",
};

const RESET: JsonSchema = {
  additionalProperties: false,
  properties: { _tag: { enum: ["LandofileReset"], type: "string" } },
  required: ["_tag"],
  type: "object",
};

const DIRECTIVE_PATH: JsonSchema = {
  anyOf: [OVERRIDE_STRING, RESET, { type: "string" }],
};

const DIRECTIVE_OBJECT: JsonSchema = {
  additionalProperties: false,
  properties: { path: DIRECTIVE_PATH },
  type: "object",
};

/** Bare Landofile / TemplateRenderContext service sqlite property. */
export const BARE_SQLITE: JsonSchema = SQLITE_OBJECT;

/** Authoring context service sqlite property: object or whole-template expression. */
export const AUTHORING_SQLITE: JsonSchema = {
  anyOf: [SQLITE_OBJECT, EXPRESSION],
};

/** Directive-capable fragment service sqlite property. */
export const DIRECTIVE_SQLITE: JsonSchema = {
  anyOf: [
    {
      additionalProperties: false,
      properties: {
        _tag: { enum: ["LandofileOverride"], type: "string" },
        value: { anyOf: [DIRECTIVE_OBJECT, EXPRESSION] },
      },
      required: ["_tag"],
      type: "object",
    },
    RESET,
    DIRECTIVE_OBJECT,
    EXPRESSION,
  ],
};

const isServiceConfigProperties = (properties: JsonValue): properties is JsonSchema =>
  isJsonObject(properties) &&
  isJsonObject(properties.database) &&
  isJsonObject(properties.image) &&
  isJsonObject(properties.type) &&
  !("sqlite" in properties);

const hasDirectiveProjection = (value: JsonValue): boolean => {
  if (Array.isArray(value)) return value.some(hasDirectiveProjection);
  if (!isJsonObject(value)) return false;
  const tag = isJsonObject(value.properties) ? value.properties._tag : undefined;
  if (isJsonObject(tag) && Array.isArray(tag.enum) && tag.enum.includes("LandofileOverride")) return true;
  return Object.values(value).some(hasDirectiveProjection);
};

const objectSibling = (properties: JsonSchema): JsonValue | undefined =>
  properties.creds ?? properties.config ?? properties.build;

const sqliteFor = (properties: JsonSchema): JsonSchema => {
  const sibling = objectSibling(properties);
  if (hasDirectiveProjection(sibling ?? properties)) return structuredClone(DIRECTIVE_SQLITE);
  return isJsonObject(sibling) && Array.isArray(sibling.anyOf)
    ? structuredClone(AUTHORING_SQLITE)
    : structuredClone(BARE_SQLITE);
};

/**
 * Replay optional `services.*.sqlite` onto repaired historical service configs.
 * Bare, authoring, and directive projections are independently pinned.
 */
export const evolveHistoricalSqliteTarget = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    const properties = next.properties;
    if (
      value.type === "object" &&
      value.additionalProperties === false &&
      isJsonObject(properties) &&
      isServiceConfigProperties(properties)
    ) {
      next.properties = { ...properties, sqlite: sqliteFor(properties) };
    }
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
