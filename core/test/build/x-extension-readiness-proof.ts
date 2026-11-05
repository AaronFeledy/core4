import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import containerUserDelta from "./fixtures/x-extension-container-user.delta.json";
import { shorthandDelta } from "./x-extension-shorthand-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

/** Change only an exact scalar leaf, retaining expression and directive alternatives. */
const evolveScalar = (value: JsonValue, before: JsonSchema, after: JsonSchema): JsonValue => {
  if (jsonEquals(value, before)) return structuredClone(after);
  if (Array.isArray(value)) return value.map((child) => evolveScalar(child, before, after));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, evolveScalar(child, before, after)]),
  );
};

/**
 * Replay independent readiness after shell shorthand. Both fields publish the
 * shared accepted probe grammar; native-health host/user rejection is decode-only.
 * Derive new fields from historical projections, never from a current artifact.
 * Authoring projections intentionally omit scalar refinements.
 */
export const evolveHistoricalReadiness = (
  historical: JsonSchema,
  mode: "bare" | "authoring" = "bare",
): JsonSchema => {
  const evolveProbe = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(evolveProbe);
    if (!isJsonObject(value)) return value;
    const properties = value.properties;
    const keys = shorthandDelta.healthcheckKeys;
    if (
      value.type === "object" &&
      value.additionalProperties === false &&
      isJsonObject(properties) &&
      Array.isArray(keys) &&
      jsonEquals(Object.keys(properties).sort(), keys)
    ) {
      const kind = properties.kind;
      const url = properties.url;
      if (kind === undefined || url === undefined) throw new TypeError("Missing historical probe fields");
      return {
        ...value,
        properties: {
          ...properties,
          target: evolveScalar(
            kind,
            { type: "string", enum: ["command", "http", "none", "tcp"] },
            {
              type: "string",
              enum: ["host", "service"],
            },
          ),
          user: evolveScalar(
            url,
            { type: "string" },
            mode === "bare" ? containerUserDelta.after : { type: "string" },
          ),
          ...Object.fromEntries(
            (mode === "bare" ? ["intervalSeconds", "startPeriodSeconds", "timeoutSeconds"] : []).map(
              (field) => {
                const before = properties[field];
                if (before === undefined) throw new TypeError(`Missing historical probe ${field}`);
                return [
                  field,
                  evolveScalar(
                    before,
                    { type: "number" },
                    {
                      type: "number",
                      ...(field === "timeoutSeconds" ? { exclusiveMinimum: 0 } : { minimum: 0 }),
                    },
                  ),
                ];
              },
            ),
          ),
        },
      };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, evolveProbe(child)]));
  };
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const properties = next.properties;
    if (isJsonObject(properties) && isJsonObject(properties.healthcheck) && !("readiness" in properties)) {
      const probe = evolveProbe(properties.healthcheck);
      next.properties = { ...properties, healthcheck: probe, readiness: structuredClone(probe) };
    }
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
