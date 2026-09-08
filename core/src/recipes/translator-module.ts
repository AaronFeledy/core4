/**
 * In-process plugin module for the bundled `recipe` config translator.
 *
 * Built by the private init pipeline and injected through
 * `makeConfigTranslatorRegistryLive([module])`; not a separate workspace package.
 */
import { Schema } from "effect";

import { type LandoPluginModule, definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import {
  RECIPE_TRANSLATOR_ID,
  type RecipeConfigTranslatorPorts,
  makeRecipeConfigTranslator,
} from "./config-translator.ts";

const RECIPE_PLUGIN_NAME = "@lando/recipe" as const;

const SUMMARY = "Decode a recipe request into a canonical Landofile authoring fragment.";

export const makeRecipeTranslatorModule = (ports: RecipeConfigTranslatorPorts): LandoPluginModule => {
  const translator = makeRecipeConfigTranslator(ports);
  const manifest = Schema.decodeSync(PluginManifest)({
    name: RECIPE_PLUGIN_NAME,
    version: "0.0.0",
    api: 4,
    requires: { "@lando/core": "^4.0.0" },
    description: SUMMARY,
    enabled: true,
    contributes: {
      configTranslators: [
        {
          id: RECIPE_TRANSLATOR_ID,
          module: "./src/recipes/config-translator.ts",
          inputKinds: ["recipe-request"],
          summary: SUMMARY,
        },
      ],
    },
    entry: "./src/recipes/translator-module.ts",
  });
  return definePlugin({
    name: manifest.name,
    manifest,
    configTranslators: new Map([[RECIPE_TRANSLATOR_ID, async () => translator]]),
  });
};
