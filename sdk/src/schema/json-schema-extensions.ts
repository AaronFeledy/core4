import { Predicate } from "effect";

export const repairTemplateLiteralExtensionRecords = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const entry of value) repairTemplateLiteralExtensionRecords(entry);
    return;
  }
  if (!Predicate.isObject(value)) return;
  const patternProperties = value.patternProperties;
  if (Predicate.isObject(patternProperties) && Object.hasOwn(patternProperties, "^x-[\\s\\S]*?$")) {
    const { "^x-[\\s\\S]*?$": extension, ...patterns } = patternProperties;
    value.patternProperties = { ...patterns, "^x-": extension };
  }
  for (const nested of Object.values(value)) repairTemplateLiteralExtensionRecords(nested);
};

export const repairLandofileExtensions = (schema: unknown): void => {
  if (!Predicate.isObject(schema)) return;
  const definitions = schema.$defs ?? schema.definitions;
  const root =
    Predicate.isObject(definitions) && Predicate.isObject(definitions.LandofileShape)
      ? definitions.LandofileShape
      : schema;
  root.additionalProperties = false;
  root.patternProperties = { "^x-": { $id: "/schemas/unknown", title: "unknown" } };
  Reflect.deleteProperty(root, "propertyNames");
};
