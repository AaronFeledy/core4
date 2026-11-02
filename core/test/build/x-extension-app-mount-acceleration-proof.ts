import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

// Post-shorthand app-mount objects. `source` and `type` are already present.
// Service `mounts` entries share this key set, so the addition stays under `appMount`.
const APP_MOUNT_KEYS = ["excludes", "includes", "readOnly", "source", "target", "type"];

/**
 * Replay the optional `accelerate` boolean on `appMount` objects only.
 * The added schema is that object's own `readOnly` projection: bare boolean,
 * authoring boolean-or-expression, or the directive override/reset envelope.
 * Run this after shorthand evolution.
 */
export const evolveHistoricalAppMountAcceleration = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue, inAppMount: boolean): JsonValue => {
    if (Array.isArray(value)) return value.map((child) => visit(child, inAppMount));
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = visit(child, inAppMount || key === "appMount");
    }
    const properties = next.properties;
    if (
      !inAppMount ||
      value.type !== "object" ||
      value.additionalProperties !== false ||
      !isJsonObject(properties)
    ) {
      return next;
    }
    const actualKeys = Object.keys(properties).sort();
    if (
      actualKeys.length !== APP_MOUNT_KEYS.length ||
      actualKeys.some((key, index) => key !== APP_MOUNT_KEYS[index])
    ) {
      return next;
    }
    const readOnly = properties.readOnly;
    if (!isJsonObject(readOnly)) throw new TypeError("Expected the historical app-mount readOnly schema");
    next.properties = { ...properties, accelerate: structuredClone(readOnly) };
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical, false)));
};
