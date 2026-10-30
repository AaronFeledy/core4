import { createHash } from "node:crypto";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import sensitivityDelta from "./fixtures/x-extension-tooling-sensitivity.delta.json";
import { TYPED_EXPRESSION_PATTERN, wireObject } from "./x-extension-wire-proof.ts";

// Reviewed delta: a tooling task may also be `false` (disable) or a non-empty
// command string other than the reserved `disabled`. The task object itself is unchanged.
const TASK_KEYS = [
  "args",
  "arguments",
  "cmd",
  "cmds",
  "deprecated",
  "description",
  "dir",
  "disabled",
  "env",
  "flags",
  "service",
  "summary",
  "user",
  "vars",
];
const BARE_SHORTHANDS: readonly JsonSchema[] = [
  { type: "string", minLength: 1, allOf: [{ not: { const: "disabled" } }] },
  { type: "boolean", enum: [false] },
];
// Authoring wire strings carry no plain-text constraints, so the shorthand string
// also covers the whole-template expression branch it used to need.
const AUTHORING_SHORTHANDS: readonly JsonSchema[] = [{ type: "string" }, { type: "boolean", enum: [false] }];

const isTaskObject = (value: JsonValue): boolean => {
  if (!isJsonObject(value) || value.type !== "object" || value.additionalProperties !== false) return false;
  const properties = value.properties;
  if (!isJsonObject(properties)) return false;
  const keys = Object.keys(properties).sort();
  return keys.length === TASK_KEYS.length && keys.every((key, index) => key === TASK_KEYS[index]);
};

const isExpressionBranch = (value: JsonValue): boolean =>
  isJsonObject(value) &&
  value.type === "string" &&
  value.pattern === TYPED_EXPRESSION_PATTERN &&
  Object.keys(value).length === 2;

/** Replay the reviewed tooling-task shorthand delta onto an evolved historical graph. */
export const evolveHistoricalToolingShorthand = (
  historical: JsonSchema,
  projection: "bare" | "authoring",
): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    if (projection === "bare" && isTaskObject(value.additionalProperties ?? null)) {
      next.additionalProperties = { anyOf: [next.additionalProperties ?? null, ...BARE_SHORTHANDS] };
    }
    if (projection === "authoring" && Array.isArray(next.anyOf) && next.anyOf.some(isTaskObject)) {
      next.anyOf = [...next.anyOf.filter((member) => !isExpressionBranch(member)), ...AUTHORING_SHORTHANDS];
    }
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};

export const evolveHistoricalToolingSensitivity = (
  historical: JsonSchema,
  projection: "bare" | "authoring",
): JsonSchema => {
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const properties = value.properties;
    if (!isJsonObject(properties) || !("choices" in properties) || !("default" in properties)) return next;
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (
      !sensitivityDelta.before.some((entry) => entry.projection === projection && entry.sha256 === digest)
    ) {
      return next;
    }
    return {
      ...next,
      properties: {
        ...wireObject(next.properties),
        sensitive:
          projection === "bare" ? sensitivityDelta.bareSensitive : sensitivityDelta.authoringSensitive,
      },
    };
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
