import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import probePortDelta from "./fixtures/x-extension-probe-port.delta.json";
import { shorthandDelta } from "./x-extension-shorthand-proof.ts";

/** Reviewed narrowing of the service `port` from any number to a TCP port number. */
export const HISTORICAL_SERVICE_PORT: JsonSchema = { type: "number" };
export const CURRENT_SERVICE_PORT: JsonSchema = { maximum: 65535, minimum: 1, type: "integer" };

/**
 * Replay the port narrowing onto a repaired historical graph. Only a service
 * config (an object declaring both `port` and `ports`) changes, so a healthcheck
 * or endpoint `port` keeps its historical schema until `evolveHistoricalProbePort`.
 */
export const evolveHistoricalServicePort = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonSchema): JsonSchema => {
    const next: Record<string, JsonSchema[keyof JsonSchema]> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = Array.isArray(child)
        ? child.map((item) => (isJsonObject(item) ? visit(item) : item))
        : isJsonObject(child)
          ? visit(child)
          : child;
    }
    const properties = next.properties;
    if (
      isJsonObject(properties) &&
      isJsonObject(properties.ports) &&
      isJsonObject(properties.port) &&
      jsonEquals(properties.port, HISTORICAL_SERVICE_PORT)
    ) {
      next.properties = { ...properties, port: CURRENT_SERVICE_PORT };
    }
    return next;
  };
  return visit(historical);
};

const healthcheckKeys = shorthandDelta.healthcheckKeys;
if (!Array.isArray(healthcheckKeys)) throw new TypeError("Missing healthcheck key inventory");

/** Probe objects after readiness also carry target/user; before readiness they match healthcheckKeys alone. */
const probeKeySets = [[...healthcheckKeys].sort(), [...healthcheckKeys, "target", "user"].sort()] as const;

const isProbeObject = (value: JsonValue): boolean => {
  if (!isJsonObject(value) || value.type !== "object" || !isJsonObject(value.properties)) return false;
  const keys = Object.keys(value.properties).sort();
  return probeKeySets.some((expected) => jsonEquals(keys, expected));
};

/**
 * Replay the bare Landofile HTTP/TCP probe `port` narrowing. Wire/authoring keeps
 * expression-capable number ports; only the closed bare embedding publishes the
 * integer TCP bounds. Derive from the pinned delta, never from a live artifact.
 */
export const evolveHistoricalProbePort = (historical: JsonSchema): JsonSchema => {
  if (!jsonEquals(probePortDelta.before, HISTORICAL_SERVICE_PORT)) {
    throw new TypeError("Probe-port delta before must match the historical number schema");
  }
  if (!jsonEquals(probePortDelta.after, CURRENT_SERVICE_PORT)) {
    throw new TypeError("Probe-port delta after must match the current port schema");
  }
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (!isProbeObject(value)) return next;
    const properties = next.properties;
    if (!isJsonObject(properties) || !jsonEquals(properties.port, probePortDelta.before)) {
      throw new TypeError("Expected the exact historical bare probe port");
    }
    return {
      ...next,
      properties: { ...properties, port: structuredClone(probePortDelta.after) },
    };
  };
  return visit(historical) as JsonSchema;
};
