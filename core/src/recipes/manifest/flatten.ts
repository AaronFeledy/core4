import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Effect } from "effect";

import {
  RecipeExtendsError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
  type RecipeSourceError,
} from "@lando/sdk/errors";

import { BUNDLED_RECIPES } from "../bundled";
import type { GitRecipeCloner } from "../git-source";
import { loadRecipeTs } from "../ts-loader";
import { mergeRecipeManifests, stripExtendsAndDrop } from "./merge";
import { readRemoteParent } from "./parent-source";
import { parseRecipeYaml } from "./parser";

export const MAX_RECIPE_EXTENDS_DEPTH = 3;

export interface FlattenRecipeContext {
  readonly hops: number;
  readonly chain: ReadonlyArray<string>;
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  /** When false, local parent hops load YAML only and never execute recipe.ts. */
  readonly allowRecipeTs?: boolean;
  /** When set, local parent hops must stay inside this published recipe root. */
  readonly jailRoot?: string;
}

type ParentScheme = "builtin" | "local" | "git" | "github" | "npm" | "registry" | "unknown";

type FlattenError =
  | RecipeExtendsError
  | RecipeManifestParseError
  | RecipeManifestValidationError
  | RecipeSourceError;

const REMOTE_SCHEMES = new Set<ParentScheme>(["git", "github", "npm", "registry"]);

const detectParentScheme = (ref: string): ParentScheme => {
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

const looksLikeFilesystemPath = (source: string): boolean =>
  source.startsWith("./") ||
  source.startsWith("../") ||
  source.startsWith("/") ||
  source.startsWith("~/") ||
  isAbsolute(source) ||
  source.endsWith(".yml") ||
  source.endsWith(".yaml") ||
  source.endsWith(".ts");

const localIdentity = (path: string): string => {
  const resolved = resolve(path);
  const base = resolved.split(/[\\/]/).pop();
  return base === "recipe.yml" || base === "recipe.yaml" || base === "recipe.ts"
    ? dirname(resolved)
    : resolved;
};

const identityOf = (source: string): string =>
  looksLikeFilesystemPath(source) ? localIdentity(source) : source;

const parentNotFound = (ref: string, chain: ReadonlyArray<string>): RecipeExtendsError =>
  new RecipeExtendsError({
    message: `Recipe parent "${ref}" was not found.`,
    chain: [...chain, ref],
    kind: "parent-not-found",
    remediation:
      "Point extends at a bundled recipe id or a local recipe directory that contains recipe.yml or recipe.ts.",
  });

const extendsError = (kind: "cycle" | "depth", chain: ReadonlyArray<string>): RecipeExtendsError => {
  switch (kind) {
    case "cycle":
      return new RecipeExtendsError({
        message: "Recipe extends chain contains a cycle.",
        chain,
        kind,
        remediation: "Remove the cycle from the recipe extends chain.",
      });
    case "depth":
      return new RecipeExtendsError({
        message: `Recipe extends chain exceeds ${MAX_RECIPE_EXTENDS_DEPTH} hops.`,
        chain,
        kind,
        remediation: `Shorten the extends chain to at most ${MAX_RECIPE_EXTENDS_DEPTH} hops.`,
      });
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const extendsRefOf = (parsed: Record<string, unknown>): string | undefined => {
  const value = parsed.extends;
  return typeof value === "string" && value !== "" ? value : undefined;
};

const expandLocalParent = (ref: string, childSource: string): string => {
  const cwd = looksLikeFilesystemPath(childSource) ? dirname(childSource) : childSource;
  if (ref.startsWith("~/")) return resolve(process.env.HOME ?? cwd, ref.slice(2));
  if (isAbsolute(ref)) return ref;
  return resolve(cwd, ref);
};

const escapesJail = (expanded: string, jailRoot: string): boolean => {
  const rel = relative(resolve(jailRoot), resolve(expanded));
  return rel === ".." || rel.startsWith(`..${rel.includes("\\") ? "\\" : "/"}`) || isAbsolute(rel);
};

const parentIdentity = (ref: string, childSource: string): string => {
  const scheme = detectParentScheme(ref);
  switch (scheme) {
    case "local":
      return localIdentity(expandLocalParent(ref, childSource));
    case "builtin":
    case "git":
    case "github":
    case "npm":
    case "registry":
    case "unknown":
      return ref;
    default: {
      const _exhaustive: never = scheme;
      return _exhaustive;
    }
  }
};

interface RawParent {
  readonly source: string;
  readonly parsed: unknown;
}

const readText = (
  path: string,
  ref: string,
  chain: ReadonlyArray<string>,
): Effect.Effect<string, RecipeExtendsError> =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: () => parentNotFound(ref, chain),
  });

const readBuiltinParent = (
  ref: string,
  chain: ReadonlyArray<string>,
): Effect.Effect<RawParent, RecipeExtendsError | RecipeManifestParseError> => {
  const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === ref);
  if (entry === undefined) return Effect.fail(parentNotFound(ref, chain));
  return parseRecipeYaml({ source: entry.source, content: entry.manifestYaml }).pipe(
    Effect.map((parsed) => ({ source: entry.source, parsed })),
  );
};

const readLocalParent = (
  ref: string,
  childSource: string,
  ctx: FlattenRecipeContext,
): Effect.Effect<RawParent, FlattenError> =>
  Effect.gen(function* () {
    const expanded = expandLocalParent(ref, childSource);
    if (ctx.jailRoot !== undefined && escapesJail(expanded, ctx.jailRoot)) {
      return yield* Effect.fail(parentNotFound(ref, ctx.chain));
    }
    const ymlPath = resolve(expanded, "recipe.yml");
    const tsPath = resolve(expanded, "recipe.ts");
    const [ymlExists, tsExists] = yield* Effect.tryPromise({
      try: () => Promise.all([Bun.file(ymlPath).exists(), Bun.file(tsPath).exists()]),
      catch: () => parentNotFound(ref, ctx.chain),
    });
    if (ymlExists && tsExists) {
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          message: `Both recipe.yml and recipe.ts are present in ${expanded}. A recipe ships one or the other, never both.`,
          source: expanded,
          issues: ["recipe.yml and recipe.ts are mutually exclusive in a recipe directory"],
        }),
      );
    }
    if (tsExists && ctx.allowRecipeTs === false) {
      return yield* Effect.fail(
        new RecipeManifestValidationError({
          message: `Remote recipe parents cannot execute recipe.ts at ${tsPath}.`,
          source: tsPath,
          issues: ["remote extends hops load YAML only; recipe.ts is not executed from a remote parent tree"],
        }),
      );
    }
    if (tsExists) {
      const content = yield* readText(tsPath, ref, ctx.chain);
      const parsed = yield* loadRecipeTs({ filePath: tsPath, recipeRoot: expanded, content });
      return { source: tsPath, parsed };
    }
    if (!ymlExists) return yield* Effect.fail(parentNotFound(ref, ctx.chain));
    const content = yield* readText(ymlPath, ref, ctx.chain);
    return { source: ymlPath, parsed: yield* parseRecipeYaml({ source: ymlPath, content }) };
  });

const readParent = (
  ref: string,
  childSource: string,
  ctx: FlattenRecipeContext,
): Effect.Effect<RawParent, FlattenError> => {
  const scheme = detectParentScheme(ref);
  switch (scheme) {
    case "builtin":
      return readBuiltinParent(ref, ctx.chain);
    case "local":
      return readLocalParent(ref, childSource, ctx);
    case "github":
    case "git":
    case "npm":
    case "registry":
      return readRemoteParent(ref, ctx, ctx.chain);
    case "unknown":
      return Effect.fail(parentNotFound(ref, ctx.chain));
    default: {
      const _exhaustive: never = scheme;
      return _exhaustive;
    }
  }
};

const nextFlattenContext = (
  ctx: FlattenRecipeContext,
  ref: string,
  parentSource: string,
  nextIdentity: string,
): FlattenRecipeContext => {
  const scheme = detectParentScheme(ref);
  const remoteJail = REMOTE_SCHEMES.has(scheme)
    ? { allowRecipeTs: false as const, jailRoot: localIdentity(parentSource) }
    : {};
  return {
    ...ctx,
    hops: ctx.hops + 1,
    chain: [...ctx.chain, nextIdentity],
    ...remoteJail,
  };
};

const flattenRaw = (
  source: string,
  parsed: unknown,
  ctx: FlattenRecipeContext,
): Effect.Effect<Record<string, unknown>, FlattenError> =>
  Effect.gen(function* () {
    if (!isRecord(parsed)) return {};
    const ref = extendsRefOf(parsed);
    if (ref === undefined) return stripExtendsAndDrop(parsed);

    const nextIdentity = parentIdentity(ref, source);
    if (ctx.chain.includes(nextIdentity)) {
      return yield* Effect.fail(extendsError("cycle", [...ctx.chain, nextIdentity]));
    }
    if (ctx.hops >= MAX_RECIPE_EXTENDS_DEPTH) {
      return yield* Effect.fail(extendsError("depth", [...ctx.chain, nextIdentity]));
    }

    const parent = yield* readParent(ref, source, ctx);
    const parentFlat = yield* flattenRaw(
      parent.source,
      parent.parsed,
      nextFlattenContext(ctx, ref, parent.source, nextIdentity),
    );
    return mergeRecipeManifests(parentFlat, parsed);
  });

export const flattenRecipe = (
  source: string,
  parsed: unknown,
  ctx?: Partial<FlattenRecipeContext>,
): Effect.Effect<Record<string, unknown>, FlattenError> => {
  if (!isRecord(parsed)) return Effect.succeed({});
  return flattenRaw(source, parsed, {
    hops: ctx?.hops ?? 0,
    chain: ctx?.chain ?? [identityOf(source)],
    ...(ctx?.userDataRoot === undefined ? {} : { userDataRoot: ctx.userDataRoot }),
    ...(ctx?.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: ctx.gitRecipeCloner }),
    ...(ctx?.allowRecipeTs === undefined ? {} : { allowRecipeTs: ctx.allowRecipeTs }),
    ...(ctx?.jailRoot === undefined ? {} : { jailRoot: ctx.jailRoot }),
  });
};
