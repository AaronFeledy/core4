import { realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import {
  RecipeExtendsError,
  type RecipeManifestParseError,
  RecipeManifestValidationError,
  type RecipeSourceError,
} from "@lando/sdk/errors";
import { validationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";
import { BUNDLED_RECIPES } from "../bundled";
import type { GitRecipeCloner } from "../git-source";
import { type NpmRegistryClient, defaultNpmRegistryClient } from "../npm-source";
import type {
  RecipeTransportEvidence,
  ResolvedAuthoredSource,
  ResolvedRecipeSource,
} from "../resolved-source-types";
import { localParentPath, parentNotFound, readLocalParent } from "../source-parent-local";
import { validateRecipeSourceObject } from "../source-parse";
import { recipePathEscapes } from "../source-support";
import type { TarballRecipeExtractor, TarballRecipeFetcher } from "../tarball-source";
import { composeRecipeSources } from "./merge";
import type { RecipeDeclarationOrigin } from "./origins";
import { readRemoteParent } from "./parent-source";

export const MAX_RECIPE_EXTENDS_DEPTH = 3;

export interface FlattenRecipeContext {
  readonly onWarn?: (message: string) => void | Promise<void>;
  readonly hops: number;
  readonly chain: readonly string[];
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  readonly npmRegistryClient?: NpmRegistryClient;
  readonly registryUrl?: string;
  readonly tarballRecipeFetcher?: TarballRecipeFetcher;
  readonly tarballRecipeExtractor?: TarballRecipeExtractor;
  readonly allowRecipeTs?: boolean;
  readonly jailRoot?: string;
  readonly evaluation?: "declarative" | "typescript";
  readonly content?: string;
  readonly transport?: RecipeTransportEvidence;
}

type FlattenError =
  | RecipeExtendsError
  | RecipeManifestParseError
  | RecipeManifestValidationError
  | RecipeSourceError;

const isRemote = (ref: string) => /^(?:github:|git\+|git@|git:\/\/|npm:|registry:)/u.test(ref);
const isLocal = (ref: string) => isAbsolute(ref) || /^(?:\.\.?\/|~\/)/u.test(ref);

const readParent = Effect.fnUntraced(function* (ref: string, source: string, ctx: FlattenRecipeContext) {
  if (isRemote(ref)) return yield* readRemoteParent(ref, ctx, ctx.chain);
  if (isLocal(ref)) return yield* readLocalParent(ref, source, ctx);
  const entry = BUNDLED_RECIPES.find((recipe) => recipe.id === ref);
  if (entry === undefined) return yield* Effect.fail(parentNotFound(ref, ctx.chain));
  return {
    source: entry.source,
    parsed: entry.authoredSource,
    content: entry.manifestYaml,
    evaluation: "declarative" as const,
  };
});

const flattenRaw = Effect.fnUntraced(function* (
  source: string,
  parsed: unknown,
  ctx: FlattenRecipeContext,
): Effect.fn.Return<ResolvedRecipeSource, FlattenError> {
  const value = yield* validateRecipeSourceObject(source, parsed);
  let origin: RecipeDeclarationOrigin = { kind: "bundled", id: value.id };
  if (isAbsolute(source)) {
    origin = yield* Effect.tryPromise({
      try: async () => {
        const root = await realpath(dirname(source));
        const acquisitionRoot = ctx.jailRoot === undefined ? undefined : await realpath(ctx.jailRoot);
        if (
          acquisitionRoot !== undefined &&
          (recipePathEscapes(root, acquisitionRoot) ||
            recipePathEscapes(await realpath(source), acquisitionRoot))
        )
          throw parentNotFound(source, ctx.chain);
        return {
          kind: "directory" as const,
          root,
          ...(acquisitionRoot === undefined ? {} : { acquisitionRoot }),
        };
      },
      catch: () => parentNotFound(source, ctx.chain),
    });
  }
  const evaluation = ctx.evaluation ?? "declarative";
  if (evaluation === "typescript" && ctx.allowRecipeTs === false)
    return yield* Effect.fail(
      new RecipeManifestValidationError({
        source,
        message: "Remote recipe trees cannot evaluate TypeScript.",
        issues: [validationIssue([], "remote extends hops load YAML only")],
      }),
    );
  const { extends: _extends, ...portableSource } = value;
  const declaration: ResolvedAuthoredSource = {
    value,
    origin,
    evaluation,
    evidence: {
      contentDigest: `sha256:${sha256Hex(canonicalJson(portableSource))}`,
      ...(ctx.content === undefined ? {} : { rawDigest: `sha256:${sha256Hex(ctx.content)}` }),
      ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    },
  };
  const ref = value.extends;
  if (ref === undefined) return composeRecipeSources([], declaration);
  const identity = isLocal(ref)
    ? yield* Effect.tryPromise({
        try: () => realpath(localParentPath(ref, source)),
        catch: () => parentNotFound(ref, ctx.chain),
      })
    : ref;
  const chain = [...ctx.chain, identity];
  if (ctx.chain.includes(identity) || ctx.hops >= MAX_RECIPE_EXTENDS_DEPTH) {
    const kind = ctx.chain.includes(identity) ? "cycle" : "depth";
    return yield* Effect.fail(
      new RecipeExtendsError({
        message: `Recipe extends chain has a ${kind} violation.`,
        chain,
        kind,
        remediation: `Remove cycles and keep extends chains within ${MAX_RECIPE_EXTENDS_DEPTH} hops.`,
      }),
    );
  }
  const parent = yield* readParent(ref, source, ctx);
  const remote = isRemote(ref);
  const parentRoot = "acquisitionRoot" in parent ? parent.acquisitionRoot : undefined;
  const transport = "transport" in parent ? parent.transport : isLocal(ref) ? ctx.transport : undefined;
  const { transport: _transport, ...inheritedContext } = ctx;
  const ancestors = yield* flattenRaw(parent.source, parent.parsed, {
    ...inheritedContext,
    hops: ctx.hops + 1,
    chain,
    content: parent.content,
    evaluation: parent.evaluation,
    ...(remote ? { allowRecipeTs: false } : {}),
    ...(parentRoot === undefined ? {} : { jailRoot: parentRoot }),
    ...(transport === undefined ? {} : { transport }),
  });
  return composeRecipeSources(ancestors.sources, declaration);
});

export const flattenRecipe = (source: string, parsed: unknown, ctx: Partial<FlattenRecipeContext> = {}) =>
  flattenRaw(source, parsed, {
    ...ctx,
    npmRegistryClient: ctx.npmRegistryClient ?? defaultNpmRegistryClient(ctx.registryUrl),
    hops: ctx.hops ?? 0,
    chain: ctx.chain ?? [isAbsolute(source) ? dirname(source) : source],
  });
