import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { toolingVarsDeltas } from "./fixtures/x-extension-tooling-vars.delta.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

/** Replay the reviewed tooling vars change: a task declares `cmd`; `toolingDefaults` does not. */
export const evolveHistoricalToolingVars = (historical: JsonSchema): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const fields = next.properties;
    if (!isJsonObject(fields) || fields.vars === undefined) return next;
    const delta = toolingVarsDeltas.find(({ before }) => jsonEquals(fields.vars, before));
    if (delta === undefined) return next;
    const vars = fields.cmd === undefined ? delta.defaults : delta.task;
    return { ...next, properties: { ...fields, vars: structuredClone(vars) } };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
