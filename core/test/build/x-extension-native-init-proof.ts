import { type JsonSchema, isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import delta from "./fixtures/x-extension-native-init.delta.json";

export const evolveHistoricalNativeInit = (historical: JsonSchema): JsonSchema => {
  const properties = historical.properties;
  if (!isJsonObject(properties)) throw new TypeError("Missing Landofile properties");
  const services = properties.services;
  if (!isJsonObject(services)) throw new TypeError("Missing Landofile services");
  const service = services.additionalProperties;
  if (!isJsonObject(service)) throw new TypeError("Missing service record schema");
  const fields = service.properties;
  if (!isJsonObject(fields)) throw new TypeError("Missing service properties");
  if (!jsonEquals(fields.init, delta.before))
    throw new TypeError("Expected the exact historical service init");
  return {
    ...historical,
    properties: {
      ...properties,
      services: {
        ...services,
        additionalProperties: {
          ...service,
          properties: { ...fields, init: structuredClone(delta.after) },
        },
      },
    },
  };
};
