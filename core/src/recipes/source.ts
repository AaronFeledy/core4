/**
 * Recipe source resolver.
 *
 * Supported recipe source forms:
 *   - bare `<id>` — bundled built-in recipe (no disk read at runtime)
 *   - `./path` or `/abs/path` — local directory containing `recipe.yml`
 *
 * Unsupported here and rejected with a tagged `NotImplementedError`:
 *   - `github:owner/repo[/path][@ref]`
 *   - `git+https://…`, `git+ssh://…`, `git@…`
 *   - `npm:@scope/pkg[/path][@version]`
 *   - `registry:<id>[@version]`
 *
 * Resolution is deterministic and never touches the network: bundled refs
 * are read from the in-binary `BUNDLED_RECIPES` table; local refs are read
 * from the host filesystem under the supplied `cwd`.
 */
import { basename, isAbsolute, resolve } from "node:path";

import { Effect } from "effect";

import {
  NotImplementedError,
  RecipeManifestNotFoundError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";
import type { RecipeManifest } from "@lando/sdk/schema";

import { BUNDLED_RECIPES } from "./bundled.ts";
import { validateRecipeManifestObject } from "./manifest/service.ts";
import { loadRecipeTs } from "./ts-loader.ts";

/**
 * The directory-resolution boundary enforces that a local recipe id matches
 * the directory basename before schema parsing. The `^` anchor restricts the
 * match to top-level YAML scalars (column 0); nested `id:` keys (e.g. a
 * prompt whose `name:` is `"id"`) are indented and skipped.
 */
const TOP_LEVEL_ID_RE = /^id:[ \t]+(?:"([^"]+)"|'([^']+)'|([^\s#]+))[ \t]*(?:#.*)?$/m;

const extractTopLevelId = (manifestYaml: string): string | undefined => {
  const match = TOP_LEVEL_ID_RE.exec(manifestYaml);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
};

export interface ResolvedRecipe {
  readonly id: string;
  readonly source: string;
  readonly manifestYaml: string;
  readonly root: string | undefined;
  // Set for `recipe.ts` recipes; when present the caller skips YAML parsing.
  readonly manifest?: typeof RecipeManifest.Type;
}

export interface ResolveRecipeOptions {
  readonly cwd: string;
}

export type RecipeRefScheme = "builtin" | "local" | "git" | "github" | "npm" | "registry" | "unknown";

const detectScheme = (ref: string): RecipeRefScheme => {
  if (ref.startsWith("github:")) return "github";
  if (ref.startsWith("git+") || ref.startsWith("git@") || ref.startsWith("git://")) return "git";
  if (ref.startsWith("npm:")) return "npm";
  if (ref.startsWith("registry:")) return "registry";
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") || ref.startsWith("~/")) {
    return "local";
  }
  if (isAbsolute(ref)) return "local";
  if (/^[a-z0-9][a-z0-9-]*$/u.test(ref)) return "builtin";
  return "unknown";
};

const BETA_REMEDIATION = "Remove the source scheme; remote recipe sources are not supported yet.";

const notImplemented = (scheme: string, ref: string): NotImplementedError =>
  new NotImplementedError({
    message: `Recipe source scheme "${scheme}" (ref "${ref}") is not supported yet.`,
    commandId: "recipe.source.resolve",
    remediation: BETA_REMEDIATION,
  });

const resolveBuiltin = (ref: string): Effect.Effect<ResolvedRecipe, RecipeManifestNotFoundError> => {
  const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === ref);
  if (entry === undefined) {
    return Effect.fail(
      new RecipeManifestNotFoundError({
        message:
          `Unknown built-in recipe "${ref}". ` +
          `Known built-in recipes: ${BUNDLED_RECIPES.map((recipe) => recipe.id).join(", ") || "(none)"}.`,
        source: ref,
      }),
    );
  }
  return Effect.succeed({
    id: entry.id,
    source: entry.source,
    manifestYaml: entry.manifestYaml,
    root: undefined,
  });
};

const expandLocalPath = (ref: string, options: ResolveRecipeOptions): string =>
  ref.startsWith("~/")
    ? resolve(process.env.HOME ?? options.cwd, ref.slice(2))
    : isAbsolute(ref)
      ? ref
      : resolve(options.cwd, ref);

const idMismatchError = (
  declaredId: string,
  dirBasename: string,
  manifestPath: string,
): RecipeManifestValidationError =>
  new RecipeManifestValidationError({
    message:
      `Recipe id "${declaredId}" must match the directory basename "${dirBasename}" ` +
      `(recipe at ${manifestPath}).`,
    source: manifestPath,
    issues: [`id: "${declaredId}" must equal directory basename "${dirBasename}"`],
  });

const resolveLocalTs = (
  ref: string,
  expanded: string,
  tsPath: string,
): Effect.Effect<
  ResolvedRecipe,
  RecipeManifestNotFoundError | RecipeManifestValidationError | RecipeManifestParseError | NotImplementedError
> =>
  Effect.gen(function* () {
    const content = yield* Effect.tryPromise({
      try: () => Bun.file(tsPath).text(),
      catch: (cause) =>
        new RecipeManifestNotFoundError({
          message: `Could not read recipe.ts at ${tsPath}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          source: tsPath,
        }),
    });
    const parsed = yield* loadRecipeTs({ filePath: tsPath, recipeRoot: expanded, content });
    const manifest = yield* validateRecipeManifestObject(tsPath, parsed);
    const dirBasename = basename(expanded);
    if (manifest.id !== dirBasename) {
      return yield* Effect.fail(idMismatchError(manifest.id, dirBasename, tsPath));
    }
    return { id: ref, source: tsPath, manifestYaml: "", root: expanded, manifest };
  });

const resolveLocal = (
  ref: string,
  options: ResolveRecipeOptions,
): Effect.Effect<
  ResolvedRecipe,
  RecipeManifestNotFoundError | RecipeManifestValidationError | RecipeManifestParseError | NotImplementedError
> =>
  Effect.gen(function* () {
    const expanded = expandLocalPath(ref, options);
    const manifestPath = resolve(expanded, "recipe.yml");
    const tsPath = resolve(expanded, "recipe.ts");
    const [yamlExists, tsExists] = yield* Effect.tryPromise({
      try: () => Promise.all([Bun.file(manifestPath).exists(), Bun.file(tsPath).exists()]),
      catch: (cause) =>
        new RecipeManifestNotFoundError({
          message: `Could not stat recipe manifest at ${expanded}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          source: expanded,
        }),
    });

    if (yamlExists && tsExists) {
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          message: `Both recipe.yml and recipe.ts are present in ${expanded}. A recipe ships one or the other, never both.`,
          source: expanded,
          issues: ["recipe.yml and recipe.ts are mutually exclusive in a recipe directory"],
        }),
      );
    }

    if (tsExists) return yield* resolveLocalTs(ref, expanded, tsPath);

    if (!yamlExists) {
      return yield* Effect.fail(
        new RecipeManifestNotFoundError({
          message: `Neither recipe.yml nor recipe.ts found in ${expanded}.`,
          source: manifestPath,
        }),
      );
    }

    const manifestYaml = yield* Effect.tryPromise({
      try: () => Bun.file(manifestPath).text(),
      catch: (cause) =>
        new RecipeManifestNotFoundError({
          message: `Could not read recipe.yml at ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          source: manifestPath,
        }),
    });
    const dirBasename = basename(expanded);
    const declaredId = extractTopLevelId(manifestYaml);
    if (declaredId !== undefined && declaredId !== dirBasename) {
      return yield* Effect.fail(idMismatchError(declaredId, dirBasename, manifestPath));
    }
    return {
      id: ref,
      source: manifestPath,
      manifestYaml,
      root: expanded,
    };
  });

export const resolveRecipeRef = (
  ref: string,
  options: ResolveRecipeOptions,
): Effect.Effect<
  ResolvedRecipe,
  RecipeManifestNotFoundError | RecipeManifestValidationError | RecipeManifestParseError | NotImplementedError
> => {
  if (ref.trim() === "") {
    return Effect.fail(notImplemented("unknown", ref));
  }
  const scheme = detectScheme(ref);
  switch (scheme) {
    case "builtin":
      return resolveBuiltin(ref);
    case "local":
      return resolveLocal(ref, options);
    case "github":
    case "git":
    case "npm":
    case "registry":
      return Effect.fail(notImplemented(scheme, ref));
    case "unknown":
      return Effect.fail(notImplemented("unknown", ref));
  }
};
