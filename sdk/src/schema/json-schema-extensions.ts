import { Predicate } from "effect";

export const repairTemplateLiteralExtensionRecords = (
  value: unknown,
  options?: { readonly compactUnrestrictedValues: boolean },
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) repairTemplateLiteralExtensionRecords(entry, options);
    return;
  }
  if (!Predicate.isObject(value)) return;
  const patternProperties = value.patternProperties;
  if (Predicate.isObject(patternProperties) && Object.hasOwn(patternProperties, "^x-[\\s\\S]*?$")) {
    const { "^x-[\\s\\S]*?$": extension, ...patterns } = patternProperties;
    const unrestricted =
      Predicate.isObject(extension) && Object.keys(extension).every((key) => key === "description");
    value.patternProperties = {
      ...patterns,
      "^x-": options?.compactUnrestrictedValues && unrestricted ? true : extension,
    };
  }
  for (const nested of Object.values(value)) repairTemplateLiteralExtensionRecords(nested, options);
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
