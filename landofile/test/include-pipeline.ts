import { join } from "node:path";
import type { LandofileRecipeProvenance } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  type ResolveLandofileIncludesOptions,
  type UpdateLandofileIncludesOptions,
  type VerifyLandofileIncludesOptions,
  resolveLandofileIncludes,
  updateLandofileIncludes,
  verifyLandofileIncludes,
} from "../src/includes.ts";
import { buildLandofileLoadScope } from "../src/pipeline/materialize.ts";

export const authoredRecipe = (options: LandofileRecipeProvenance["options"]) => ({
  id: "lamp",
  version: "0.1.0",
  options,
  producer: {
    sourceKind: "bundled" as const,
    packageName: "@lando/recipe-lamp",
    recipeId: "lamp",
    manifestVersion: "0.1.0",
    contentDigest: `sha256:${"0".repeat(64)}`,
  },
});

const compileScope = (options: Pick<ResolveLandofileIncludesOptions, "landofile" | "appRoot">) =>
  buildLandofileLoadScope([{ file: join(options.appRoot, ".lando.yml"), value: options.landofile }]);

export const resolveAuthoredIncludes = (options: Omit<ResolveLandofileIncludesOptions, "loadScope">) =>
  compileScope(options).pipe(
    Effect.flatMap((loadScope) => resolveLandofileIncludes({ ...options, loadScope })),
  );
export const updateAuthoredIncludes = (options: Omit<UpdateLandofileIncludesOptions, "loadScope">) =>
  compileScope(options).pipe(
    Effect.flatMap((loadScope) => updateLandofileIncludes({ ...options, loadScope })),
  );
export const verifyAuthoredIncludes = (options: Omit<VerifyLandofileIncludesOptions, "loadScope">) =>
  compileScope(options).pipe(
    Effect.flatMap((loadScope) => verifyLandofileIncludes({ ...options, loadScope })),
  );
