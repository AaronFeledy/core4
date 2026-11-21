import { expect, test } from "bun:test";
import { LandofileAuthoringFragment, getJsonSchema } from "@lando/sdk/schema";
import { JsonSchema, Predicate, Result, Schema, SchemaRepresentation } from "effect";
import { importableNode } from "./landofile-parity-json-schema-fixup.ts";

const artifact = await Bun.file(
  new URL("../../../dist/schemas/landofile-authoring-fragment.json", import.meta.url),
).json();
expect(artifact).toEqual(getJsonSchema("LandofileAuthoringFragment"));
const expand = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(expand);
  if (!Predicate.isObject(node)) return node;
  if (typeof node.$ref === "string") {
    expect(node.$ref.startsWith("#/$defs/")).toBe(true);
    const definition: unknown = artifact.$defs[node.$ref.slice("#/$defs/".length)];
    expect(Predicate.isObject(definition)).toBe(true);
    return expand(definition);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expand(value)]));
};
const ports = expand(artifact.$defs.ServiceConfigInputAuthoringFragment.properties.ports);
if (!Predicate.isObject(ports)) throw new Error("Missing published ports schema");
const imported = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(ports), {
  patterns: "apply",
  onEnter: importableNode,
});

test.each([
  { ports: [80, "8080:80"], decoder: true, published: true },
  {
    ports: [{ target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }],
    decoder: true,
    published: true,
  },
  // Runtime Type camelCase is rejected by the authoring decoder under excess rejection;
  // the published JSON Schema projection still admits additional long-form properties.
  {
    ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }],
    decoder: false,
    published: true,
  },
  { ports: null, decoder: false, published: false },
  { ports: [null], decoder: false, published: false },
  { ports: [{ target: null }], decoder: false, published: false },
  { ports: [{ target: -1 }], decoder: false, published: false },
])("published override ports agree with the decoder (%#)", ({ ports, decoder, published }) => {
  const input = {
    services: {
      _tag: "LandofileOverride",
      value: {
        web: {
          _tag: "LandofileOverride",
          value: { ports: { _tag: "LandofileOverride", value: ports } },
        },
      },
    },
  };
  const decoded = Schema.decodeUnknownResult(LandofileAuthoringFragment)(input, {
    onExcessProperty: "error",
  });
  expect(Result.isSuccess(decoded)).toBe(decoder);
  expect(Schema.is(imported)(input.services.value.web.value.ports)).toBe(published);
});
