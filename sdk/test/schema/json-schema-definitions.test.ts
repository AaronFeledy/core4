import { expect, test } from "bun:test";
import { pruneUnusedDefinitions } from "../../src/schema/json-schema-definitions.ts";

test("keeps transitive recursive definitions and removes unreachable recursive islands", () => {
  const document = {
    $ref: "#/$defs/First",
    $defs: {
      First: { type: "object", properties: { next: { $ref: "#/$defs/Second" } } },
      Second: { type: "object", properties: { next: { $ref: "#/$defs/First" } } },
      Abandoned: { $ref: "#/$defs/Abandoned" },
    },
  };
  expect(pruneUnusedDefinitions(document)).toEqual({
    $ref: "#/$defs/First",
    $defs: { First: document.$defs.First, Second: document.$defs.Second },
  });
});

test("follows escaped definition names and pointers into definitions", () => {
  const document = {
    type: "array",
    items: { $ref: "#/$defs/a~1b~0c/properties/value" },
    $defs: { "a/b~c": { type: "object", properties: { value: { type: "string" } } } },
  };
  expect(pruneUnusedDefinitions(structuredClone(document))).toEqual(document);
});

test("removes definitions left only in literal instance data", () => {
  expect(
    pruneUnusedDefinitions({
      type: "object",
      properties: { value: { const: { $ref: "#/$defs/Abandoned" } } },
      $defs: { Abandoned: { type: "null" } },
    }),
  ).toEqual({
    type: "object",
    properties: { value: { const: { $ref: "#/$defs/Abandoned" } } },
  });
});

test("does not confuse properties named like annotations with instance data", () => {
  const document = {
    properties: { default: { $ref: "#/$defs/Value" }, const: { $ref: "#/$defs/Value" } },
    $defs: { Value: { type: "null" } },
  };
  expect(pruneUnusedDefinitions(structuredClone(document))).toEqual(document);
});
