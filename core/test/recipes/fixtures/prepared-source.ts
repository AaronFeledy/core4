import { plugin } from "@lando/lando4";
import { RecipeSource } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { compileResolvedRecipe } from "../../../src/recipes/compiled-source.ts";
import { prepareRecipeInit } from "../../../src/recipes/prepared-init.ts";
import { resolveRecipeSource } from "../../../src/recipes/resolved-source.ts";

export const compileTestSource = async (source: unknown, root: string) => {
  const authoredSource = Schema.decodeUnknownSync(RecipeSource)(source);
  return Effect.runPromise(
    resolveRecipeSource({
      id: authoredSource.id,
      source: `${root}/recipe.ts`,
      manifestYaml: "",
      root,
      authoredSource,
      evaluation: "typescript",
    }).pipe(Effect.flatMap(compileResolvedRecipe)),
  );
};
export const testSource = {
  id: "prepared",
  version: "1.0.0",
  title: "Prepared source",
  description: "Preparation fixture",
  config: { runtime: 4, services: { app: { type: "lando", image: "alpine:3.21" } } },
};
export const prepareTestSource = async (source: unknown, root: string, appRoot: string) => {
  const compiled = await compileTestSource(source, root);
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing test encoder");
  const result = await Effect.runPromise(
    prepareRecipeInit({ compiled, appRoot, appName: "prepared", answers: {}, encoder: await loader() }),
  );
  if (result.status !== "ready") throw new Error(`Missing fixture answers: ${result.missing.join(",")}`);
  return result;
};
