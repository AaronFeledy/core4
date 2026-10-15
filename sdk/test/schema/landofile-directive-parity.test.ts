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
  { ports: [80, "8080:80"], accepted: true },
  { ports: [{ target: 80, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }], accepted: true },
  { ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1", protocol: "tcp" }], accepted: true },
  { ports: null, accepted: false },
  { ports: [null], accepted: false },
  { ports: [{ target: null }], accepted: false },
  { ports: [{ target: -1 }], accepted: false },
])("published override ports agree with the decoder (%#)", ({ ports, accepted }) => {
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
  expect(Result.isSuccess(decoded)).toBe(accepted);
  expect(Schema.is(imported)(input.services.value.web.value.ports)).toBe(accepted);
});
