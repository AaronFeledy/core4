import { expect, test } from "bun:test";
import { type JsonSchema, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { schemaAt } from "./x-extension-closed-record.ts";
import { configOutputLandofile } from "./x-extension-config-output.ts";

const strictLandofile = {
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string" }, services: { type: "object" } },
} satisfies JsonSchema;
const resolved = {
  type: "object",
  required: ["source", "landofile"],
  properties: {
    source: { type: "string", enum: ["resolved"] },
    path: { not: {} },
    subcommand: { not: {} },
    landofile: strictLandofile,
  },
} satisfies JsonSchema;
const merged: JsonSchema = {
  ...resolved,
  properties: {
    ...resolved.properties,
    source: { type: "string", enum: ["merged"] },
    landofile: {},
  },
};

test.each([
  [merged, resolved],
  [resolved, merged],
])("selects by role when arms are reordered: %j", (first, second) => {
  // Given known independent input trees, with the permissive merged view in either position.
  const schema = { anyOf: [first, second] };
  // When the resolved embedding is selected.
  const selected = configOutputLandofile(schema);
  // Then it is the complete strict input, not the permissive alternative.
  expect(selected).toEqual(strictLandofile);
});

const invalid: readonly [string, JsonSchema][] = [
  ["missing", { anyOf: [] }],
  ["duplicate", { anyOf: [resolved, resolved] }],
  ["merged only", { anyOf: [merged] }],
  [
    "ambiguous source",
    {
      ...resolved,
      properties: { ...resolved.properties, source: { enum: ["merged", "resolved"], type: "string" } },
    },
  ],
  ["projection", { ...resolved, properties: { ...resolved.properties, path: { type: "string" } } }],
  [
    "get",
    { ...resolved, properties: { ...resolved.properties, subcommand: { enum: ["get"], type: "string" } } },
  ],
  [
    "write",
    { ...resolved, properties: { ...resolved.properties, subcommand: { enum: ["set"], type: "string" } } },
  ],
  ["optional source", { ...resolved, required: ["landofile"] }],
  ["optional landofile", { ...resolved, required: ["source"] }],
  ["weak resolved subtree", { ...resolved, properties: { ...resolved.properties, landofile: {} } }],
  [
    "overlapping source alongside a strict role",
    {
      anyOf: [
        resolved,
        { ...resolved, properties: { ...resolved.properties, source: { enum: ["merged", "resolved"] } } },
      ],
    },
  ],
  [
    "unconstrained source alongside a strict role",
    { anyOf: [resolved, { ...resolved, properties: { ...resolved.properties, source: {} } }] },
  ],
];

test.each(invalid)("rejects a %s alternative without falling back", (_name, alternative) => {
  // Given an invalid role or union, alongside a tempting merged view.
  const schema = alternative.anyOf === undefined ? { anyOf: [merged, alternative] } : alternative;
  // When selection is attempted, then it fails closed.
  expect(() => configOutputLandofile(schema)).toThrow();
});

test("rejects duplicate roles even when only one subtree is strict", () => {
  // Given two resolved-role claims, one carrying permissive JSON.
  const weak = { ...resolved, properties: { ...resolved.properties, landofile: {} } };
  // When selection is attempted, then subtree validity cannot break the role ambiguity.
  expect(() => configOutputLandofile({ anyOf: [resolved, weak] })).toThrow();
});

test("preserves a mutated strict subtree for independent equality to reject", () => {
  // Given a role-correct tree with an unrelated constraint changed.
  const mutated = {
    ...strictLandofile,
    properties: { ...strictLandofile.properties, name: { type: "number" } },
  };
  const schema = {
    anyOf: [merged, { ...resolved, properties: { ...resolved.properties, landofile: mutated } }],
  };
  // When the full resolved role is selected.
  const selected = configOutputLandofile(schema);
  // Then no historical expected data is grafted over the mutation.
  expect(selected).toEqual(mutated);
  expect(jsonEquals(strictLandofile, selected)).toBe(false);
});

test("keeps direct embeddings and generic path traversal strict", () => {
  // Given a direct context embedding and a config output union.
  const direct = { properties: { landofile: strictLandofile } };
  // When the proof-specific selector reads the direct embedding.
  const selected = configOutputLandofile(direct);
  // Then direct traversal is unchanged and generic traversal never guesses union arms.
  expect(selected).toEqual(strictLandofile);
  expect(() => schemaAt({ anyOf: [resolved] }, "$.landofile")).toThrow();
  expect(() => configOutputLandofile({ ...direct, anyOf: [resolved] })).toThrow();
});
