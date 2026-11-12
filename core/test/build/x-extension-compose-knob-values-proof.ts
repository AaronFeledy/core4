import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { CURRENT_SERVICE_PORT } from "./x-extension-port-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const FIELDS = [
  "privileged",
  "read_only",
  "shm_size",
  "stop_grace_period",
  "deploy",
  "gpus",
  "ulimits",
] as const;

const delta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-compose-knob-values.delta.json")).json(),
);

const pairFor = (field: (typeof FIELDS)[number]): { historical: JsonSchema; current: JsonSchema } => {
  const pair = delta[field];
  if (!isJsonObject(pair) || !isJsonObject(pair.historical) || !isJsonObject(pair.current)) {
    throw new Error(`compose knob delta missing ${field}`);
  }
  return { historical: pair.historical, current: pair.current };
};

/** Replay reviewed Compose knob value narrowing onto bare service configs only. */
export const evolveHistoricalComposeKnobValues = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) {
      const items = value.map(visit);
      return items.some((item, index) => item !== value[index]) ? items : value;
    }
    if (!isJsonObject(value)) return value;
    let childChanged = false;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const visited = visit(child);
      next[key] = visited;
      if (visited !== child) childChanged = true;
    }
    const fields = next.properties;
    if (!isJsonObject(fields) || !jsonEquals(fields.port, CURRENT_SERVICE_PORT)) {
      return childChanged ? next : value;
    }
    let properties = fields;
    for (const field of FIELDS) {
      const pair = pairFor(field);
      if (jsonEquals(properties[field], pair.historical)) {
        properties = { ...properties, [field]: structuredClone(pair.current) };
      }
    }
    if (properties === fields) return childChanged ? next : value;
    return { ...next, properties };
  };
  const evolved = visit(historical);
  return evolved === historical ? historical : normalizeJsonSchema(wireObject(evolved));
};
