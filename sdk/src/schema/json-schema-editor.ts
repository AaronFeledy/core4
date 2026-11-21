import { JsonSchema, Predicate } from "effect";

import { GlobalConfig } from "./config.ts";
import { jsonSchemaDocument, withSchemaDeprecations } from "./json-schema-deprecations.ts";
import { repairLandofileExtensions } from "./json-schema-extensions.ts";
import { LandofileAuthoringShape } from "./landofile-authoring.ts";
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
  const match = /^#\/definitions\/(.+)$/u.exec(node.$ref);
  return match?.[1];
};

/**
 * Drop decoded-only descriptor definitions and every anyOf/oneOf arm that only
 * referenced them, so the published input document describes authored syntax alone.
 */
const dropDecodedInputDescriptors = (artifact: Record<string, unknown>): void => {
  const definitions = artifact.definitions;
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
  dropDecodedInputDescriptors(artifact as Record<string, unknown>);
  const definitions = artifact.definitions;
  if (Predicate.isObject(definitions) && Predicate.isObject(definitions.ToolingTaskInputAuthoring)) {
    constrainTaskStrings(definitions.ToolingTaskInputAuthoring);
  }
  return { ...artifact, "x-lando-yaml-tags": LANDOFILE_YAML_TAGS };
};
