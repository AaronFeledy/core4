import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const HISTORICAL_CREDS_REQUIRED = ["database", "password", "user"];
const HISTORICAL_OVERRIDE_REQUIRED = ["_tag", "value"];
const CURRENT_OVERRIDE_REQUIRED = ["_tag"];

/**
 * Replay the move of service login fields under `creds`, plus the optional bucket name.
 * `framework` is the projection witness: bucket is the same optional string in every
 * reviewed surface, and the lawful normalizer has already removed descriptions.
 * Bare creds names the historical required array. Authoring unions keep that array on
 * the object branch. Directive unions omit it, and the database, password, and user
 * override envelopes no longer require `value`. Nested password overrides still do.
 * Run this after sqlite evolution; that proof still recognizes the historical `database` field.
 */
const credsCanEvolve = (creds: JsonValue): boolean =>
  isJsonObject(creds) &&
  (creds.required === undefined || jsonEquals(creds.required, HISTORICAL_CREDS_REQUIRED));

const withoutHistoricalCredsRequired = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutHistoricalCredsRequired);
  if (!isJsonObject(value)) return value;
  const next: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "required" && jsonEquals(child, HISTORICAL_CREDS_REQUIRED)) continue;
    next[key] = withoutHistoricalCredsRequired(child);
  }
  return next;
};

const narrowFieldOverrideRequired = (field: JsonValue): JsonValue => {
  if (!isJsonObject(field) || !Array.isArray(field.anyOf)) return field;
  return {
    ...field,
    anyOf: field.anyOf.map((branch) => {
      if (!isJsonObject(branch) || !jsonEquals(branch.required, HISTORICAL_OVERRIDE_REQUIRED)) return branch;
      const tag = isJsonObject(branch.properties) ? branch.properties._tag : undefined;
      if (!isJsonObject(tag) || !jsonEquals(tag.enum, ["LandofileOverride"])) return branch;
      return { ...branch, required: CURRENT_OVERRIDE_REQUIRED };
    }),
  };
};

const isCredsObject = (value: JsonValue): value is JsonSchema =>
  isJsonObject(value) &&
  value.type === "object" &&
  isJsonObject(value.properties) &&
  isJsonObject(value.properties.database) &&
  isJsonObject(value.properties.password) &&
  isJsonObject(value.properties.user);

const narrowCredsMemberOverrides = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(narrowCredsMemberOverrides);
  if (!isJsonObject(value)) return value;
  if (isCredsObject(value)) {
    const properties = value.properties;
    return {
      ...value,
      properties: {
        ...properties,
        database: narrowFieldOverrideRequired(properties.database),
        password: narrowFieldOverrideRequired(properties.password),
        user: narrowFieldOverrideRequired(properties.user),
      },
    };
  }
  const next: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) next[key] = narrowCredsMemberOverrides(child);
  return next;
};

const evolveCreds = (creds: JsonValue): JsonValue =>
  narrowCredsMemberOverrides(withoutHistoricalCredsRequired(creds));

const isHistoricalService = (properties: JsonSchema): boolean =>
  isJsonObject(properties.type) &&
  isJsonObject(properties.image) &&
  isJsonObject(properties.database) &&
  isJsonObject(properties.password) &&
  isJsonObject(properties.framework) &&
  isJsonObject(properties.creds) &&
  properties.bucket === undefined &&
  credsCanEvolve(properties.creds);

export const evolveHistoricalServiceCreds = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    const properties = next.properties;
    if (value.type !== "object" || !isJsonObject(properties) || !isHistoricalService(properties)) return next;
    const { database: _database, password: _password, ...rest } = properties;
    return {
      ...next,
      properties: {
        ...rest,
        bucket: structuredClone(properties.framework),
        creds: evolveCreds(wireObject(properties.creds)),
      },
    };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
