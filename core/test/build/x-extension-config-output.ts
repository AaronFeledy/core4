import { type JsonSchema, isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { schemaAt } from "./x-extension-closed-record.ts";

/** Select the full resolved output role, never a permissive merged or selected-value view. */
export const configOutputLandofile = (schema: JsonSchema): JsonSchema => {
  if (schema.anyOf === undefined) return schemaAt(schema, "$.landofile");
  if (!Array.isArray(schema.anyOf) || schema.properties !== undefined) {
    throw new Error("Expected an unambiguous config output union");
  }
  const candidates = schema.anyOf.filter((branch) => {
    if (!isJsonObject(branch) || !isJsonObject(branch.properties)) return false;
    const properties = branch.properties;
    const source = properties.source;
    return (
      branch.type === "object" &&
      Array.isArray(branch.required) &&
      branch.required.includes("source") &&
      branch.required.includes("landofile") &&
      isJsonObject(source) &&
      (source.enum === undefined || (Array.isArray(source.enum) && source.enum.includes("resolved"))) &&
      jsonEquals(properties.path, { not: {} }) &&
      jsonEquals(properties.subcommand, { not: {} })
    );
  });
  const [resolved] = candidates;
  if (candidates.length !== 1 || !isJsonObject(resolved)) {
    throw new Error("Expected exactly one full resolved config output role");
  }
  if (!jsonEquals(schemaAt(resolved, "$.source"), { type: "string", enum: ["resolved"] })) {
    throw new Error("Expected an exclusive resolved source discriminator");
  }
  const landofile = schemaAt(resolved, "$.landofile");
  if (
    landofile.type !== "object" ||
    !isJsonObject(landofile.properties) ||
    landofile.additionalProperties !== false
  ) {
    throw new Error("Expected a strict resolved Landofile subtree");
  }
  return landofile;
};
