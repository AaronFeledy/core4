import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import capture from "./fixtures/x-extension-schedule.delta.json";
import { wireObject } from "./x-extension-wire-proof.ts";

const parsed = wireObject(capture);
const rawDeltas = parsed.deltas;
if (!Array.isArray(rawDeltas)) throw new TypeError("schedule deltas must be an array");

export const scheduleDeltas = rawDeltas.map((entry) => {
  const row = wireObject(entry);
  return {
    mode: row.mode,
    field: wireObject(row.field),
    witness: wireObject(row.witness),
  };
});

/** Replay only the reviewed optional schedule field on a repaired service object. */
export const evolveHistoricalSchedule = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const fields = next.properties;
    if (
      value.type !== "object" ||
      !isJsonObject(fields) ||
      fields.type === undefined ||
      fields.image === undefined ||
      fields.ports === undefined ||
      fields.uploadDirs === undefined ||
      fields.schedule !== undefined
    )
      return next;
    const delta = scheduleDeltas.find(({ witness }) => jsonEquals(fields.uploadDirs, witness));
    return delta === undefined
      ? next
      : { ...next, properties: { ...fields, schedule: structuredClone(delta.field) } };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
