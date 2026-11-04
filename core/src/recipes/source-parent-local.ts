import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { RecipeExtendsError, RecipeManifestValidationError } from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { FlattenRecipeContext } from "./manifest/flatten";
import { parseRecipeYaml } from "./manifest/parser";
import { recipePathEscapes } from "./source-support";
import { loadRecipeTs } from "./ts-loader";

export const parentNotFound = (ref: string, chain: readonly string[]) =>
  new RecipeExtendsError({
    message: `Recipe parent "${ref}" was not found or escapes its acquisition root.`,
    chain: [...chain, ref],
    kind: "parent-not-found",
    remediation: "Point extends at a bundled recipe or a recipe inside the acquired tree.",
  });

export const localParentPath = (ref: string, source: string) => {
  const cwd = isAbsolute(source) ? dirname(source) : source;
  return ref.startsWith("~/") ? resolve(process.env.HOME ?? cwd, ref.slice(2)) : resolve(cwd, ref);
};

export const readLocalParent = Effect.fnUntraced(function* (
  ref: string,
  source: string,
  ctx: FlattenRecipeContext,
) {
  const expanded = localParentPath(ref, source);
  const root = yield* Effect.tryPromise({
    try: async () => {
      const root = await realpath(expanded);
      if (ctx.jailRoot !== undefined) {
        const jail = await realpath(ctx.jailRoot);
        if (recipePathEscapes(expanded, jail) || recipePathEscapes(root, jail))
          throw parentNotFound(ref, ctx.chain);
      }
      return root;
    },
    catch: () => parentNotFound(ref, ctx.chain),
  });
  const ymlPath = resolve(root, "recipe.yml");
  const tsPath = resolve(root, "recipe.ts");
  const [ymlExists, tsExists] = yield* Effect.tryPromise({
    try: () => Promise.all([Bun.file(ymlPath).exists(), Bun.file(tsPath).exists()]),
    catch: () => parentNotFound(ref, ctx.chain),
  });
  if ((ymlExists && tsExists) || (tsExists && ctx.allowRecipeTs === false)) {
    return yield* Effect.fail(
      new RecipeManifestValidationError({
        source: root,
        message: "Recipe directories must contain one author source; remote trees permit recipe.yml only.",
        issues: [
          validationIssue([], "recipe.yml and recipe.ts are mutually exclusive; remote TS is forbidden"),
        ],
      }),
    );
  }
  if (!ymlExists && !tsExists) return yield* Effect.fail(parentNotFound(ref, ctx.chain));
  const path = tsExists ? tsPath : ymlPath;
  const content = yield* Effect.tryPromise({
    try: async () => {
      const file = await realpath(path);
      if (ctx.jailRoot !== undefined && recipePathEscapes(file, await realpath(ctx.jailRoot)))
        throw parentNotFound(ref, ctx.chain);
      return Bun.file(file).text();
    },
    catch: () => parentNotFound(ref, ctx.chain),
  });
  const parsed = tsExists
    ? yield* loadRecipeTs({ filePath: path, recipeRoot: root, content })
    : yield* parseRecipeYaml({ source: path, content });
  return {
    source: path,
    parsed,
    content,
    evaluation: tsExists ? ("typescript" as const) : ("declarative" as const),
  };
});
