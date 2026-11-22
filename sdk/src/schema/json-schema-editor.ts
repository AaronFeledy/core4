import { JsonSchema, Predicate, type Schema } from "effect";

import { GlobalConfig } from "./config.ts";
import { globalConfigMapInputs } from "./global-config-map-limits.ts";
import { getJsonSchemaWithDeprecations } from "./json-schema-deprecations.ts";
import {
  repairLandofileExtensions,
  repairTemplateLiteralExtensionRecords,
} from "./json-schema-extensions.ts";
import { JSON_SCHEMA_FIELD_PROVENANCE_KEY } from "./json-schema-field-provenance.ts";
import {
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentWire,
  LandofileAuthoringShape,
  LandofileAuthoringShapeWire,
} from "./landofile-authoring.ts";
import { toolingTaskStringConstraints } from "./tooling-task-string.ts";

const YAML_KINDS = ["scalar", "sequence", "mapping"] as const;

/**
 * Decoded-only value descriptors that appear in runtime EnvironmentValue / ImportRef
 * contracts. Authors write strings and expressions; editor and Standard input documents
 * must not offer these object branches.
 */
const DECODED_INPUT_DESCRIPTOR =
  /^(?:SecretRef|BoundText(?:Reference)?|RouteText|RouteUrlPart|StringImportRef)Authoring(?:_\d+)?$/u;

const constrainTaskStrings = (node: unknown): void => {
  if (!Predicate.isObject(node)) return;
  if (node.type === "string" && node.pattern === undefined) Object.assign(node, toolingTaskStringConstraints);
  else if (Array.isArray(node.anyOf)) {
    for (const member of node.anyOf) constrainTaskStrings(member);
  }
};

const definitionRefName = (node: unknown): string | undefined => {
  if (!Predicate.isObject(node) || typeof node.$ref !== "string") return undefined;
  const match = /^#\/\$defs\/(.+)$/u.exec(node.$ref);
  return match?.[1];
};

/**
 * Drop decoded-only descriptor definitions and every anyOf/oneOf arm that only
 * referenced them, so the published input document describes authored syntax alone.
 */
const dropDecodedInputDescriptors = (artifact: JsonSchema.JsonSchema): void => {
  const definitions = artifact.$defs;
  if (!Predicate.isObject(definitions)) return;

  const dropped = new Set<string>();
  for (const key of Object.keys(definitions)) {
    if (!DECODED_INPUT_DESCRIPTOR.test(key)) continue;
    dropped.add(key);
    delete definitions[key];
  }
  if (dropped.size === 0) return;

  const isDroppedRef = (node: unknown): boolean => {
    const name = definitionRefName(node);
    return name !== undefined && dropped.has(name);
  };

  /** True when every alternative is a dropped ref (possibly nested one level). */
  const onlyDroppedRefs = (node: unknown): boolean => {
    if (isDroppedRef(node)) return true;
    if (!Predicate.isObject(node)) return false;
    const alts = node.anyOf ?? node.oneOf;
    return Array.isArray(alts) && alts.length > 0 && alts.every((alt) => onlyDroppedRefs(alt));
  };

  const prune = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(prune);
    if (!Predicate.isObject(node)) return node;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
        next[key] = value.map(prune).filter((member) => !onlyDroppedRefs(member));
        continue;
      }
      next[key] = prune(value);
    }
    return next;
  };

  const pruned = prune(artifact);
  if (Predicate.isObject(pruned)) {
    for (const key of Object.keys(artifact)) delete artifact[key];
    Object.assign(artifact, pruned);
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

type InputSchemaName = "LandofileShape" | "GlobalConfig";

export const projectAuthoringInput = (
  name: InputSchemaName,
  includeProvenance: boolean,
): JsonSchema.JsonSchema => {
  const schema = { LandofileShape: LandofileAuthoringShape, GlobalConfig }[name];
  const artifact = getJsonSchemaWithDeprecations(schema, {
    onExcessProperty: "error",
    // GlobalConfig has authored descriptions; generated check prose splits the router port bounds.
    generateDescriptions: name === "LandofileShape",
    includeAnnotationKey: (key) => includeProvenance && key === JSON_SCHEMA_FIELD_PROVENANCE_KEY,
  });
  const definitions = artifact.$defs;
  if (name === "GlobalConfig") {
    if (Predicate.isObject(definitions)) {
      for (const [key, metadata] of Object.entries(globalConfigMapInputs)) {
        const node = definitions[key];
        if (Predicate.isObject(node)) Object.assign(node, metadata);
      }
    }
    return artifact;
  }
  repairLandofileExtensions(artifact);
  repairTemplateLiteralExtensionRecords(artifact, { compactUnrestrictedValues: true });
  dropDecodedInputDescriptors(artifact);
  if (Predicate.isObject(definitions) && Predicate.isObject(definitions.ToolingTaskInputAuthoring)) {
    constrainTaskStrings(definitions.ToolingTaskInputAuthoring);
  }
  return artifact;
};

type AuthoringVariantName =
  | "LandofileAuthoringFragment"
  | "LandofileAuthoringFragmentWire"
  | "LandofileAuthoringShapeWire";

const authoringVariants: Readonly<Record<AuthoringVariantName, Schema.Top>> = {
  LandofileAuthoringFragment,
  LandofileAuthoringFragmentWire,
  LandofileAuthoringShapeWire,
};

export const projectAuthoringVariant = (name: AuthoringVariantName, includeProvenance: boolean) => {
  const artifact = getJsonSchemaWithDeprecations(authoringVariants[name], {
    onExcessProperty: "error",
    includeAnnotationKey: (key) => includeProvenance && key === JSON_SCHEMA_FIELD_PROVENANCE_KEY,
  });
  repairTemplateLiteralExtensionRecords(artifact);
  return artifact;
};

export const getAuthoringInputJsonSchema = (name: InputSchemaName): JsonSchema.JsonSchema =>
  projectAuthoringInput(name, false);

export const authoringDraft07 = (artifact: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  const document = JsonSchema.toDocumentDraft07(JsonSchema.fromSchemaDraft2020_12(artifact));
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
  };
};

export const getDraft07InputJsonSchema = (name: InputSchemaName): JsonSchema.JsonSchema =>
  authoringDraft07(getAuthoringInputJsonSchema(name));

/** Draft-07 projection for YAML editors, derived from the public contracts. */
export const getEditorJsonSchema = (name: InputSchemaName): JsonSchema.JsonSchema => {
  const artifact = getDraft07InputJsonSchema(name);
  return name === "LandofileShape" ? { ...artifact, "x-lando-yaml-tags": LANDOFILE_YAML_TAGS } : artifact;
};
