import { Result, Schema } from "effect";

import { GlobalConfig } from "./config.ts";
import { getAuthoringInputJsonSchema, getDraft07InputJsonSchema } from "./json-schema-editor.ts";
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

const standardAuthoringJsonSchema = <S extends Schema.Constraint>(
  schema: S,
  name: "LandofileShape" | "GlobalConfig",
) => {
  const view = Schema.toStandardJSONSchemaV1(schema);
  const jsonSchema = view["~standard"].jsonSchema;
  return Object.assign(view, {
    "~standard": {
      ...view["~standard"],
      jsonSchema: {
        ...jsonSchema,
        input(options: Parameters<typeof jsonSchema.input>[0]) {
          if (options.target === "draft-07") return getDraft07InputJsonSchema(name);
          if (options.target === "draft-2020-12") return getAuthoringInputJsonSchema(name);
          return jsonSchema.input(options);
        },
      },
    },
  });
};

// JSON Schema conversion is deferred until input() or output() is called.
export const LandofileStandardJSONSchema: ReturnType<
  typeof Schema.toStandardJSONSchemaV1<typeof LandofileAuthoringShape>
> = /* @__PURE__ */ standardAuthoringJsonSchema(
  /* @__PURE__ */ LandofileAuthoringShape.annotate({}),
  "LandofileShape",
);
export const GlobalConfigStandardJSONSchema = /* @__PURE__ */ standardAuthoringJsonSchema(
  /* @__PURE__ */ GlobalConfig.annotate({}),
  "GlobalConfig",
);
export const PluginManifestStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ PluginManifest.annotate({}),
);
export const RecipeManifestStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ RecipeManifest.annotate({}),
);
