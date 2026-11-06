import { type JsonSchema, Result, Schema } from "effect";
import { type SchemaNode, conjoin, conjuncts, fixedKeys, schemaChild } from "./config-key-navigation.ts";
import { projectKeySchema } from "./config-key-projection.ts";
import { schemaSummary } from "./config-key-summary.ts";
import { type ValidationIssuePath, formatValidationIssuePath } from "./validation-issue.ts";
import { suggestionForUnknownKey } from "./validation-key-suggestion.ts";

// ============================================================================
// Schema-derived config key documentation
// ============================================================================

export const ConfigKeyDescription = Schema.Struct({
  key: Schema.String.annotate({ description: "Full dotted config path; empty for the document root." }),
  summary: Schema.String.annotate({
    description: "Human-readable type and constraint summary for the value.",
  }),
  description: Schema.optionalKey(Schema.String).annotate({
    description: "Purpose and usage of the config key.",
  }),
  default: Schema.optionalKey(Schema.Json).annotate({
    description: "Schema-declared default when the key is omitted.",
  }),
  keys: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String.annotate({ description: "Full dotted path of a fixed child key." }),
        summary: Schema.String.annotate({
          description: "Accepted type and constraints for this child value.",
        }),
        description: Schema.optionalKey(Schema.String).annotate({
          description: "Purpose and usage of this child key.",
        }),
      }),
    ),
  ).annotate({ description: "Fixed child keys available in this mapping." }),
  schema: Schema.Json.annotate({
    description: "Self-contained projected JSON Schema with dialect and reachable definitions.",
  }),
}).annotate({
  identifier: "ConfigKeyDescription",
  description: "Schema-derived documentation for a config key or document root.",
});
export type ConfigKeyDescription = typeof ConfigKeyDescription.Type;

const descriptionOf = (document: JsonSchema.JsonSchema, node: SchemaNode): string | undefined => {
  const descriptions = new Set(
    conjuncts(document, node).flatMap((part) =>
      typeof part === "object" && typeof part.description === "string" ? [part.description] : [],
    ),
  );
  return descriptions.size === 0 ? undefined : [...descriptions].join(" ");
};

export const describeJsonSchemaPath = (
  document: JsonSchema.JsonSchema,
  path: ValidationIssuePath,
): Result.Result<
  ConfigKeyDescription,
  {
    /** The deepest path that resolved; `validKeys` are its children. */
    readonly parent: ValidationIssuePath;
    readonly validKeys: readonly string[];
    readonly suggestion?: string;
  }
> => {
  let node = conjoin(conjuncts(document, document));
  for (const [index, segment] of path.entries()) {
    const child = schemaChild(document, node, segment);
    if (child === undefined) {
      const validKeys = fixedKeys(document, node);
      const suggestion = suggestionForUnknownKey(String(segment), validKeys);
      return Result.fail({
        parent: path.slice(0, index),
        validKeys,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
    }
    node = child;
  }
  const parts = conjuncts(document, node);
  const defaultValue = parts.find((part) => typeof part !== "boolean" && "default" in part);
  const description = descriptionOf(document, node);
  const key = formatValidationIssuePath(path);
  const keys = fixedKeys(document, node).map((name) => {
    const child = schemaChild(document, node, name) ?? true;
    const childDescription = descriptionOf(document, child);
    return {
      key: key === "" ? name : `${key}.${name}`,
      summary: schemaSummary(document, child),
      ...(childDescription === undefined ? {} : { description: childDescription }),
    };
  });
  return Result.succeed({
    key,
    summary: schemaSummary(document, node),
    ...(description === undefined ? {} : { description }),
    ...(typeof defaultValue === "object"
      ? { default: Schema.decodeUnknownSync(Schema.Json)(defaultValue.default) }
      : {}),
    ...(keys.length === 0 ? {} : { keys }),
    schema: projectKeySchema(document, conjoin(parts)),
  });
};
