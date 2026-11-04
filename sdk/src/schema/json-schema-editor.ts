import { JsonSchema, Predicate } from "effect";

import { GlobalConfig } from "./config.ts";
import { jsonSchemaDocument, withSchemaDeprecations } from "./json-schema-deprecations.ts";
import { repairLandofileExtensions } from "./json-schema-extensions.ts";
import { LandofileAuthoringShape } from "./landofile-authoring.ts";
import { toolingTaskStringConstraints } from "./tooling-task-string.ts";

const YAML_KINDS = ["scalar", "sequence", "mapping"] as const;

const constrainTaskStrings = (node: unknown): void => {
  if (!Predicate.isObject(node)) return;
  if (node.type === "string" && node.pattern === undefined) Object.assign(node, toolingTaskStringConstraints);
  else if (Array.isArray(node.anyOf)) {
    for (const member of node.anyOf) constrainTaskStrings(member);
  }
};

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
  const schema = { LandofileShape: LandofileAuthoringShape, GlobalConfig }[name];
  const document = JsonSchema.toDocumentDraft07(
    jsonSchemaDocument(schema, { onExcessProperty: "error", generateDescriptions: true }),
  );
  const artifact = withSchemaDeprecations(schema, {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
  });
  if (name !== "LandofileShape") return artifact;
  repairLandofileExtensions(artifact);
  const definitions = artifact.definitions;
  if (Predicate.isObject(definitions) && Predicate.isObject(definitions.ToolingTaskInputAuthoring)) {
    constrainTaskStrings(definitions.ToolingTaskInputAuthoring);
  }
  return { ...artifact, "x-lando-yaml-tags": LANDOFILE_YAML_TAGS };
};
