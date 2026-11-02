import { resolve } from "node:path";

import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { TYPED_EXPRESSION_PATTERN, wireObject } from "./x-extension-wire-proof.ts";

export const shorthandDelta = wireObject(
  await Bun.file(resolve(import.meta.dirname, "fixtures/x-extension-shorthand.delta.json")).json(),
);

const keys = (value: JsonValue | undefined, label: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
};

const alternatives = (value: JsonValue | undefined, label: string): readonly JsonSchema[] => {
  if (!Array.isArray(value) || !value.every(isJsonObject)) throw new Error(`${label} must be schema nodes`);
  return value;
};

const sameKeys = (schema: JsonSchema, expected: readonly string[]): boolean => {
  const properties = schema.properties;
  if (!isJsonObject(properties)) return false;
  const actual = Object.keys(properties).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
};

const isHealthcheckObject = (value: JsonValue): value is JsonSchema =>
  isJsonObject(value) &&
  value.type === "object" &&
  value.additionalProperties === false &&
  sameKeys(value, keys(shorthandDelta.healthcheckKeys, "healthcheckKeys").toSorted());

const hasAppMountKeys = (value: JsonValue): value is JsonSchema => {
  if (!isJsonObject(value) || value.type !== "object" || value.additionalProperties !== false) return false;
  const properties = value.properties;
  if (!isJsonObject(properties)) return false;
  return keys(shorthandDelta.appMountKeys, "appMountKeys").every((key) => key in properties);
};

const isAppMountObject = (value: JsonValue): value is JsonSchema =>
  hasAppMountKeys(value) && sameKeys(value, keys(shorthandDelta.appMountKeys, "appMountKeys").toSorted());

const hasDirectiveProjection = (value: JsonValue): boolean => {
  if (Array.isArray(value)) return value.some(hasDirectiveProjection);
  if (!isJsonObject(value)) return false;
  const properties = value.properties;
  const tag = isJsonObject(properties) ? properties._tag : undefined;
  if (isJsonObject(tag) && Array.isArray(tag.enum) && tag.enum.includes("LandofileOverride")) return true;
  return Object.values(value).some(hasDirectiveProjection);
};

const contains = (members: readonly JsonValue[], candidate: JsonSchema): boolean =>
  members.some((member) => JSON.stringify(member) === JSON.stringify(candidate));

/** Replay the reviewed shorthand delta onto one already repaired historical schema graph. */
export const evolveHistoricalShorthand = (historical: JsonSchema): JsonSchema => {
  const bareHealthcheck = alternatives(
    shorthandDelta.bareHealthcheckAlternatives,
    "bareHealthcheckAlternatives",
  );
  const unionHealthcheck = alternatives(
    shorthandDelta.unionHealthcheckAlternatives,
    "unionHealthcheckAlternatives",
  );
  const forbiddenKey = (target: JsonValue): JsonSchema =>
    hasDirectiveProjection(target)
      ? wireObject(shorthandDelta.directiveForbiddenKey)
      : wireObject(shorthandDelta.bareForbiddenKey);
  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(visit);
    if (!isJsonObject(value)) return value;
    const next: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) next[key] = visit(child);
    const visitedProperties = next.properties;
    if (isAppMountObject(value) && isJsonObject(visitedProperties) && isJsonObject(value.properties)) {
      const projection = forbiddenKey(value.properties.target ?? null);
      next.properties = { ...visitedProperties, source: projection, type: projection };
    }
    if (Array.isArray(next.anyOf)) {
      const members = [...next.anyOf];
      if (members.some(isHealthcheckObject)) {
        for (const addition of unionHealthcheck) {
          if (!contains(members, addition)) members.push(addition);
        }
        const typedExpression = members.some(
          (member) =>
            isJsonObject(member) &&
            member.type === "string" &&
            member.pattern === TYPED_EXPRESSION_PATTERN &&
            Object.keys(member).length === 2,
        );
        // Shell-command shorthand also accepts non-expression text; do not erase a constrained branch.
        if (typedExpression) members.push({ type: "string" });
      }
      if (members.some(hasAppMountKeys) && !contains(members, wireObject(shorthandDelta.appMountString))) {
        members.push(wireObject(shorthandDelta.appMountString));
      }
      next.anyOf = members;
    }
    const properties = next.properties;
    const healthcheck = isJsonObject(properties) ? (properties.healthcheck ?? null) : null;
    if (isJsonObject(properties) && isHealthcheckObject(healthcheck)) {
      next.properties = {
        ...properties,
        healthcheck: { anyOf: [healthcheck, ...bareHealthcheck] },
      };
    }
    return next;
  };
  return normalizeJsonSchema(wireObject(visit(historical)));
};
