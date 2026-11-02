import { type JsonSchema, isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";

/** Reviewed narrowing of the service `port` from any number to a TCP port number. */
export const HISTORICAL_SERVICE_PORT: JsonSchema = { type: "number" };
export const CURRENT_SERVICE_PORT: JsonSchema = { maximum: 65535, minimum: 1, type: "integer" };

/**
 * Replay the port narrowing onto a repaired historical graph. Only a service
 * config (an object declaring both `port` and `ports`) changes, so a healthcheck
 * or endpoint `port` keeps its historical schema.
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
