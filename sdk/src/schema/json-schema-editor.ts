import { JsonSchema } from "effect";

import { GlobalConfig } from "./config.ts";
import { jsonSchemaDocument, withSchemaDeprecations } from "./json-schema-deprecations.ts";
import { repairLandofileExtensions } from "./json-schema-extensions.ts";
import { LandofileShape } from "./landofile.ts";

const YAML_KINDS = ["scalar", "sequence", "mapping"] as const;

/** Informational: native merge directives a YAML editor must register as custom tags. */
const LANDOFILE_YAML_TAGS = {
  "!override": {
    kinds: YAML_KINDS,
    description: "Replace the inherited value of this mapping member with the tagged payload.",
  },
  "!reset": {
    kinds: YAML_KINDS,
    description:
      "Remove the inherited mapping member. Any scalar or empty-collection payload is ignored; lando app:config:lint validates directive placement.",
  },
};

/** Draft-07 projection for YAML editors, derived from the public contracts. */
export const getEditorJsonSchema = (name: "LandofileShape" | "GlobalConfig"): JsonSchema.JsonSchema => {
  const schema = { LandofileShape, GlobalConfig }[name];
  const document = JsonSchema.toDocumentDraft07(
    jsonSchemaDocument(schema, { onExcessProperty: "error", generateDescriptions: true }),
  );
  const artifact = withSchemaDeprecations(schema, {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
  });
  if (name === "LandofileShape") {
    repairLandofileExtensions(artifact);
    artifact["x-lando-yaml-tags"] = LANDOFILE_YAML_TAGS;
  }
  return artifact;
};
