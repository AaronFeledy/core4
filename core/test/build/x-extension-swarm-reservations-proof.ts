import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

// Compose applies reservations.cpus and reservations.generic_resources only to Swarm services. The
// Landofile rejects both at their roots, so deploy.resources.reservations no longer declares them.
const SWARM_ONLY_RESERVATIONS: ReadonlySet<string> = new Set(["cpus", "generic_resources"]);

/** Removes the Swarm-only reservation fields from every captured reservations object. */
export const evolveHistoricalSwarmReservations = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const fields = next.properties;
    if (!isJsonObject(fields) || fields.devices === undefined || fields.generic_resources === undefined)
      return next;
    return {
      ...next,
      properties: Object.fromEntries(
        Object.entries(fields).filter(([key]) => !SWARM_ONLY_RESERVATIONS.has(key)),
      ),
    };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
