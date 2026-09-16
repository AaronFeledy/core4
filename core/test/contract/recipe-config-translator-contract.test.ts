import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { createStandaloneRedactor } from "@lando/redaction/service";
import { ConfigTranslateInput } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { type ConfigTranslatorContractHarness, runConfigTranslatorContractSuite } from "@lando/sdk/test";

import { makeRecipeTranslatorModule } from "../../src/recipes/translator-module.ts";
import {
  ISOLATED_RECIPE_ID,
  ISOLATED_RECIPE_VERSION,
  isolatedInitDecomposer,
  isolatedInitManifest,
} from "../recipes/fixtures/isolated-init-recipe/index.ts";

const redactor = createStandaloneRedactor("secrets");
const module = makeRecipeTranslatorModule({
  decomposers: new Map([[ISOLATED_RECIPE_ID, isolatedInitDecomposer]]),
  redactor,
});

const translateInput = Schema.decodeUnknownSync(ConfigTranslateInput)({
  _tag: "recipe-request",
  recipe: { id: isolatedInitManifest.id, version: ISOLATED_RECIPE_VERSION },
  sourceId: `recipe:${ISOLATED_RECIPE_ID}:init`,
  answers: { php: "8.4", webroot: "public" },
  secretAnswers: {
    apiToken: { disposition: "postInit.secretEnv", name: "ISOLATED_API_TOKEN" },
  },
});

/** Resolve the translator exactly as the plugin graph does, through the lazy loader. */
const loadBundledTranslator = async (): Promise<ConfigTranslatorShape> => {
  const loader = module.configTranslators?.get("recipe");
  if (loader === undefined) throw new Error("@lando/recipe must contribute the recipe translator.");
  return await loader();
};

describe("ConfigTranslator contract — bundled recipe", () => {
  test("the bundled recipe translator passes the contract suite", async () => {
    const translator = await loadBundledTranslator();
    expect(translator.id).toBe("recipe");
    expect(translator.encode).toBeUndefined();
    const harness: ConfigTranslatorContractHarness = {
      name: "recipe",
      translator,
      translateInput,
    };
    const exit = await Effect.runPromiseExit(runConfigTranslatorContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("the manifest contribution and the lazy loader agree on the translator id", async () => {
    const declared = module.manifest.contributes?.configTranslators?.map(({ id }) => id) ?? [];
    expect(declared).toEqual(["recipe"]);
    expect([...(module.configTranslators?.keys() ?? [])]).toEqual(declared);
    expect(declared[0]).toBe("recipe");
    expect((await loadBundledTranslator()).id).toBe("recipe");
  });
});
