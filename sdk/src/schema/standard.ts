import { Schema } from "effect";

import { GlobalConfig } from "./config.ts";
import { LandofileShape } from "./landofile.ts";
import { PluginManifest } from "./plugin.ts";
import { RecipeManifest } from "./recipe.ts";

// ====
// Standard views of the canonical input contracts.
// Effect attaches views to its argument; fresh wrappers keep canonical schemas untouched.

const options = { parseOptions: { onExcessProperty: "error", errors: "all" } } as const;

export const LandofileStandardSchema = /* @__PURE__ */ Schema.toStandardSchemaV1(
  /* @__PURE__ */ LandofileShape.annotate({}),
  options,
);
export const GlobalConfigStandardSchema = /* @__PURE__ */ Schema.toStandardSchemaV1(
  /* @__PURE__ */ GlobalConfig.annotate({}),
  options,
);
export const PluginManifestStandardSchema = /* @__PURE__ */ Schema.toStandardSchemaV1(
  /* @__PURE__ */ PluginManifest.annotate({}),
  options,
);
export const RecipeManifestStandardSchema = /* @__PURE__ */ Schema.toStandardSchemaV1(
  /* @__PURE__ */ RecipeManifest.annotate({}),
  options,
);

// JSON Schema conversion is deferred by Effect until input() or output() is called.
export const LandofileStandardJSONSchema = /* @__PURE__ */ Schema.toStandardJSONSchemaV1(
  /* @__PURE__ */ LandofileShape.annotate({}),
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
