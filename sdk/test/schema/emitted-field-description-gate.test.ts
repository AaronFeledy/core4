import { expect, test } from "bun:test";
import { getEditorJsonSchema } from "@lando/sdk/schema";
import { Predicate } from "effect";
import {
  assertEmittedFieldDescriptions,
  collectMissingFieldDescriptions,
} from "../../src/schema/emitted-field-description-gate.ts";
import { JSON_SCHEMA_FIELD_PROVENANCE_KEY } from "../../src/schema/json-schema-field-provenance.ts";

test("reports a dropped description from a non-defaulted emitted GlobalConfig field", () => {
  const artifact = getEditorJsonSchema("GlobalConfig");
  const properties = artifact.properties;
  if (!Predicate.isObject(properties) || !Predicate.isObject(properties.renderer))
    throw new Error("Missing renderer field");
  const { description, ...field } = properties.renderer;
  expect(typeof description).toBe("string");
  const edited = { ...artifact, properties: { ...properties, renderer: field } };
  const name = "global-config.schema.json";
  const before = new Set(collectMissingFieldDescriptions(artifact, name));
  expect(collectMissingFieldDescriptions(edited, name).filter((path) => !before.has(path))).toEqual([
    `${name}#/renderer`,
  ]);
});

test("reports an undocumented field reachable only through a union arm in record array items", () => {
  const document = {
    $ref: "#/$defs/Map",
    $defs: {
      Map: {
        additionalProperties: {
          items: {
            anyOf: [
              { type: "string" },
              { properties: { port: { type: "integer", title: "Port" }, legacy: { not: {} } } },
            ],
          },
        },
      },
    },
  };
  expect(collectMissingFieldDescriptions(document, "branch")).toEqual([
    "branch#/$defs/Map/additionalProperties/items/anyOf/1/port",
  ]);
});

test("requires every literal arm to be described but ignores explicit expression provenance", () => {
  const expression = { type: "string", pattern: "^\\{\\{.+\\}\\}$", description: "An expression." };
  const literal = { type: "boolean", allOf: [{ description: "Whether to enable the feature." }] };
  const document = {
    properties: {
      documented: {
        anyOf: [literal, { ...expression, [JSON_SCHEMA_FIELD_PROVENANCE_KEY]: { role: "expression-arm" } }],
      },
      missing: { anyOf: [{ type: "boolean" }, expression] },
    },
  };
  expect(collectMissingFieldDescriptions(document, "arms")).toEqual(["arms#/missing"]);
});

test("rejects both new debt and stale debt", () => {
  const artifacts = new Map([["input", { properties: { gap: { type: "string" } } }]]);
  expect(() => assertEmittedFieldDescriptions(artifacts, new Set(["input#/fixed"]))).toThrow(
    /\+ input#\/gap\n- input#\/fixed/u,
  );
});
