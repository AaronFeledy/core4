import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { RecipeManifestValidationError, causeMessage } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { RecipeDeclarationOrigin } from "./manifest/origins";
import { recipePathEscapes } from "./source-support";

export const resolveRecipeDeclarationPath = (
  origin: Extract<RecipeDeclarationOrigin, { readonly kind: "directory" }>,
  path: string,
) =>
  Effect.tryPromise({
    try: async () => {
      const root = await realpath(origin.root);
      const candidate = resolve(root, path);
      if (recipePathEscapes(candidate, root)) throw new RangeError("Declaration escapes its recipe root.");
      const canonical = await realpath(candidate);
      if (recipePathEscapes(canonical, root))
        throw new RangeError("Declaration symlink escapes its recipe root.");
      if (origin.acquisitionRoot !== undefined) {
        const jail = await realpath(origin.acquisitionRoot);
        if (recipePathEscapes(root, jail) || recipePathEscapes(canonical, jail))
          throw new RangeError("Declaration escapes its acquisition root.");
      }
      return canonical;
    },
    catch: (cause) =>
      new RecipeManifestValidationError({
        source: origin.root,
        message: `Invalid recipe declaration ${path}: ${causeMessage(cause)}`,
        issues: [
          validationIssue([], "Keep assets and scripts inside their declaring recipe and acquisition roots."),
        ],
      }),
  });
