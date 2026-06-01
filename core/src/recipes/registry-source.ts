/**
 * `registry` recipe source resolver.
 *
 * Resolves a recipe id through the Lando recipe registry, then delegates the
 * resulting git or tarball resolution to the existing remote source resolvers.
 * The registry schema intentionally does not include `ref`; git-source does not
 * support refs, so this resolver does not thread one.
 */
import { Schema } from "effect";

import { RecipeSourceError } from "@lando/sdk/errors";
import { RecipeRegistryResponse } from "@lando/sdk/schema";
import type { RecipeRegistryResponse as RecipeRegistryResponseType } from "@lando/sdk/schema";

import { type GitRecipeCloner, resolveGitRecipeSource } from "./git-source.ts";
import type { ResolvedRecipe } from "./source.ts";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  resolveTarballRecipeSource,
} from "./tarball-source.ts";

export const DEFAULT_RECIPE_REGISTRY_URL = "https://registry.lando.dev/recipes/";

export interface RecipeRegistryClient {
  readonly fetchResolution: (id: string) => Promise<RecipeRegistryResponseType | undefined>;
}

export interface ResolveRegistryRecipeSourceOptions {
  readonly id: string;
  readonly registryUrl?: string;
  readonly userDataRoot?: string;
  readonly registryClient?: RecipeRegistryClient;
  readonly path?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  readonly tarballRecipeFetcher?: TarballRecipeFetcher;
  readonly tarballRecipeExtractor?: TarballRecipeExtractor;
}

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: "missing-id" | "recipe-not-found" | "registry-invalid" | "registry-failed";
  readonly remediation: string;
}): RecipeSourceError => new RecipeSourceError(input);

class RegistryDecodeError extends Error {
  constructor(cause: unknown) {
    super(causeMessage(cause));
    this.name = "RegistryDecodeError";
  }
}

const decodeRegistryResponse = (payload: unknown): RecipeRegistryResponseType =>
  Schema.decodeUnknownSync(RecipeRegistryResponse)(payload);

export const defaultRecipeRegistryClient = (registryUrl: string): RecipeRegistryClient => ({
  fetchResolution: async (id) => {
    const base = registryUrl.replace(/\/+$/u, "");
    const response = await fetch(`${base}/${encodeURIComponent(id)}`, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    try {
      return decodeRegistryResponse(await response.json());
    } catch (cause) {
      throw new RegistryDecodeError(cause);
    }
  },
});

export const resolveRegistryRecipeSource = async (
  options: ResolveRegistryRecipeSourceOptions,
): Promise<ResolvedRecipe> => {
  const id = options.id.trim();
  if (id === "") {
    throw sourceError({
      message: "Registry recipe id is required.",
      source: options.id,
      kind: "missing-id",
      remediation: "Pass a non-empty registry recipe id, e.g. registry:drupal-10.",
    });
  }

  const registryUrl = options.registryUrl ?? DEFAULT_RECIPE_REGISTRY_URL;
  const client = options.registryClient ?? defaultRecipeRegistryClient(registryUrl);

  let response: RecipeRegistryResponseType | undefined;
  try {
    response = await client.fetchResolution(id);
  } catch (cause) {
    if (cause instanceof RegistryDecodeError) {
      throw sourceError({
        message: `Registry response for recipe id "${id}" from ${registryUrl} was invalid: ${causeMessage(cause)}`,
        source: id,
        kind: "registry-invalid",
        remediation: "Report the registry response and retry with a valid recipe id.",
      });
    }
    throw sourceError({
      message: `Could not fetch registry recipe id "${id}" from ${registryUrl}: ${causeMessage(cause)}`,
      source: id,
      kind: "registry-failed",
      remediation: "Check the registry URL and network access, then retry lando init.",
    });
  }

  if (response === undefined) {
    throw sourceError({
      message: `Recipe id "${id}" was not found in the registry ${registryUrl}.`,
      source: id,
      kind: "recipe-not-found",
      remediation: "Check the recipe id and retry lando init.",
    });
  }

  let decoded: RecipeRegistryResponseType;
  try {
    decoded = decodeRegistryResponse(response);
  } catch (cause) {
    throw sourceError({
      message: `Registry response for recipe id "${id}" from ${registryUrl} was invalid: ${causeMessage(cause)}`,
      source: id,
      kind: "registry-invalid",
      remediation: "Report the registry response and retry with a valid recipe id.",
    });
  }

  const { resolution } = decoded;
  const sourcePath = options.path ?? resolution.path;
  const resolved =
    resolution.kind === "git"
      ? await resolveGitRecipeSource({
          url: resolution.url,
          ...(sourcePath === undefined ? {} : { path: sourcePath }),
          ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
          ...(options.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: options.gitRecipeCloner }),
        })
      : await resolveTarballRecipeSource({
          url: resolution.url,
          ...(sourcePath === undefined ? {} : { path: sourcePath }),
          ...(resolution.checksum === undefined ? {} : { checksum: resolution.checksum }),
          ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
          ...(options.tarballRecipeFetcher === undefined ? {} : { fetcher: options.tarballRecipeFetcher }),
          ...(options.tarballRecipeExtractor === undefined
            ? {}
            : { extractor: options.tarballRecipeExtractor }),
        });

  return { ...resolved, id };
};
