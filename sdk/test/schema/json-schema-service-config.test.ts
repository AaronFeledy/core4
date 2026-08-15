import { describe, expect, test } from "bun:test";
import { getJsonSchema } from "@lando/sdk/schema";

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const serviceSchemaRoot = (name: "ServiceConfig" | "ServiceConfigInput"): JsonObject => {
  const generated = getJsonSchema(name);
  if (!isJsonObject(generated)) throw new Error(`${name} JSON Schema root is not an object`);
  if (name === "ServiceConfig") return generated;
  const definitions = generated.$defs;
  if (!isJsonObject(definitions) || !isJsonObject(definitions.ServiceConfigInput)) {
    throw new Error("ServiceConfigInput JSON Schema definition is missing");
  }
  return definitions.ServiceConfigInput;
};

const schemaProperty = (schema: JsonObject, name: string): unknown => {
  const properties = schema.properties;
  if (!isJsonObject(properties) || !(name in properties)) {
    throw new Error(`JSON Schema property ${name} is missing`);
  }
  return properties[name];
};

const findObjectWithProperties = (value: unknown, names: ReadonlyArray<string>): JsonObject | undefined => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findObjectWithProperties(entry, names);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  const properties = value.properties;
  if (isJsonObject(properties) && names.every((name) => name in properties)) return value;
  for (const nested of Object.values(value)) {
    const found = findObjectWithProperties(nested, names);
    if (found !== undefined) return found;
  }
  return undefined;
};

const expectExtensionObject = (schema: JsonObject): void => {
  expect(schema.propertyNames).toBeUndefined();
  expect(isJsonObject(schema.patternProperties)).toBe(true);
  if (!isJsonObject(schema.patternProperties)) throw new Error("patternProperties is missing");
  expect(schema.patternProperties["^x-"]).toBeDefined();
};

describe("ServiceConfig generated JSON Schema extension records", () => {
  test.each(["ServiceConfig", "ServiceConfigInput"] as const)(
    "Given %s JSON Schema, when inspecting its root, then fixed properties coexist with x-* extensions",
    (name) => {
      // Given / When
      const root = serviceSchemaRoot(name);

      // Then
      expectExtensionObject(root);
    },
  );

  test.each(["ServiceConfig", "ServiceConfigInput"] as const)(
    "Given %s JSON Schema, when inspecting network attachments, then fixed keys coexist with x-* extensions",
    (name) => {
      // Given / When
      const attachment = findObjectWithProperties(schemaProperty(serviceSchemaRoot(name), "networks"), [
        "aliases",
        "interface_name",
        "ipv4_address",
        "ipv6_address",
        "link_local_ips",
        "mac_address",
        "driver_opts",
        "priority",
        "gw_priority",
      ]);

      // Then
      expect(attachment).toBeDefined();
      if (attachment === undefined) throw new Error("network attachment schema is missing");
      expectExtensionObject(attachment);
    },
  );

  test.each([
    ["ServiceConfig", "configs"],
    ["ServiceConfig", "secrets"],
    ["ServiceConfigInput", "configs"],
    ["ServiceConfigInput", "secrets"],
  ] as const)(
    "Given %s JSON Schema, when inspecting %s entries, then fixed keys coexist with x-* extensions",
    (name, field) => {
      // Given / When
      const entry = findObjectWithProperties(schemaProperty(serviceSchemaRoot(name), field), [
        "source",
        "target",
        "uid",
        "gid",
        "mode",
      ]);

      // Then
      expect(entry).toBeDefined();
      if (entry === undefined) throw new Error(`${field} entry schema is missing`);
      expectExtensionObject(entry);
    },
  );
});
