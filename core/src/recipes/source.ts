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
  RecipeManifestValidationError,
} from "@lando/sdk/errors";

import { BUNDLED_RECIPES } from "./bundled.ts";

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

const BETA_REMEDIATION = "Remove the source scheme; remote recipe sources are deferred to the Beta release.";

const notImplemented = (scheme: string, ref: string, specSection = "§8.8.4"): NotImplementedError =>
  new NotImplementedError({
    message: `Recipe source scheme "${scheme}" (ref "${ref}") is not supported in Alpha.`,
    commandId: "recipe.source.resolve",
    specSection,
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

const resolveLocal = (
  ref: string,
  options: ResolveRecipeOptions,
): Effect.Effect<ResolvedRecipe, RecipeManifestNotFoundError | RecipeManifestValidationError> =>
  Effect.gen(function* () {
    const expanded = ref.startsWith("~/")
      ? resolve(process.env.HOME ?? options.cwd, ref.slice(2))
      : isAbsolute(ref)
        ? ref
        : resolve(options.cwd, ref);
    const manifestPath = resolve(expanded, "recipe.yml");
    const file = Bun.file(manifestPath);
    const exists = yield* Effect.tryPromise({
      try: () => file.exists(),
      catch: (cause) =>
        new RecipeManifestNotFoundError({
          message: `Could not stat recipe.yml at ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          source: manifestPath,
        }),
    });
    if (!exists) {
      return yield* Effect.fail(
        new RecipeManifestNotFoundError({
          message: `recipe.yml not found at ${manifestPath}.`,
          source: manifestPath,
        }),
      );
    }
    const manifestYaml = yield* Effect.tryPromise({
      try: () => file.text(),
      catch: (cause) =>
        new RecipeManifestNotFoundError({
          message: `Could not read recipe.yml at ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}.`,
          source: manifestPath,
        }),
    });
    const dirBasename = basename(expanded);
    const declaredId = extractTopLevelId(manifestYaml);
    if (declaredId !== undefined && declaredId !== dirBasename) {
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          message:
            `Recipe id "${declaredId}" must match the directory basename "${dirBasename}" ` +
            `(recipe at ${manifestPath}).`,
          source: manifestPath,
          issues: [`id: "${declaredId}" must equal directory basename "${dirBasename}"`],
        }),
      );
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
  RecipeManifestNotFoundError | RecipeManifestValidationError | NotImplementedError
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
