import { JsonSchema, Result, Schema } from "effect";

import { GlobalConfig } from "./config.ts";
import { getEditorJsonSchema } from "./json-schema-editor.ts";
import { LandofileAuthoringShape } from "./landofile-authoring.ts";
import { PluginManifest } from "./plugin.ts";
import { RecipeManifest } from "./recipe.ts";
import { schemaIssueLeaves } from "./validation-issue.ts";

// ====
// Standard views of the canonical input contracts.
// Effect attaches views to its argument; fresh wrappers keep canonical schemas untouched.

const options = { parseOptions: { onExcessProperty: "error", errors: "all" } } as const;

const standardSchema = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
): ReturnType<typeof Schema.toStandardSchemaV1<S>> => {
  const view = Schema.toStandardSchemaV1(schema, options);
  const decode = Schema.decodeUnknownResult(schema);
  return Object.assign(view, {
    "~standard": {
      ...view["~standard"],
      validate: (input: unknown) =>
        Result.match(decode(input, options.parseOptions), {
          onSuccess: (value) => ({ value }),
          onFailure: (error) => ({
            issues: schemaIssueLeaves(error.issue, [], { input }).map(({ path, message }) => ({
              path,
              message,
            })),
          }),
        }),
    },
  });
};

export const LandofileStandardSchema: ReturnType<
  typeof Schema.toStandardSchemaV1<typeof LandofileAuthoringShape>
> = /* @__PURE__ */ standardSchema(/* @__PURE__ */ LandofileAuthoringShape.annotate({}));
export const GlobalConfigStandardSchema = /* @__PURE__ */ standardSchema(
  /* @__PURE__ */ GlobalConfig.annotate({}),
);
export const PluginManifestStandardSchema = /* @__PURE__ */ standardSchema(
  /* @__PURE__ */ PluginManifest.annotate({}),
);
export const RecipeManifestStandardSchema = /* @__PURE__ */ standardSchema(
  /* @__PURE__ */ RecipeManifest.annotate({}),
);

// JSON Schema conversion is deferred by Effect until input() or output() is called.
export const LandofileStandardJSONSchema: ReturnType<
  typeof Schema.toStandardJSONSchemaV1<typeof LandofileAuthoringShape>
> = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(/* @__PURE__ */ LandofileAuthoringShape.annotate({})).pipe(
  (view) =>
    Object.assign(view, {
      "~standard": {
        ...view["~standard"],
        jsonSchema: {
          ...view["~standard"].jsonSchema,
          input(options: Parameters<(typeof view)["~standard"]["jsonSchema"]["input"]>[0]) {
            if (options.target === "draft-07") return getEditorJsonSchema("LandofileShape");
            if (options.target === "draft-2020-12") {
              const document = JsonSchema.fromSchemaDraft07(getEditorJsonSchema("LandofileShape"));
              return {
                ...document.schema,
                $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
                ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
              };
            }
            return Schema.toStandardJSONSchemaV1(LandofileAuthoringShape.annotate({}))[
              "~standard"
            ].jsonSchema.input(options);
          },
        },
      },
    }),
);
export const GlobalConfigStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ GlobalConfig.annotate({}),
);
export const PluginManifestStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ PluginManifest.annotate({}),
);
export const RecipeManifestStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ RecipeManifest.annotate({}),
);
