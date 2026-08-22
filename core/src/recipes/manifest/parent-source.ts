import { Effect } from "effect";

import {
  RecipeExtendsError,
  RecipeManifestNotFoundError,
  type RecipeManifestParseError,
  RecipeSourceError,
} from "@lando/sdk/errors";

import { type GitRecipeCloner, resolveGitRecipeSource } from "../git-source";
import { resolveNpmRecipeSource } from "../npm-source";
import { resolveRegistryRecipeSource } from "../registry-source";
import { parseRecipeYaml } from "./parser";

export interface RemoteParentContext {
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
}

export interface RawRemoteParent {
  readonly source: string;
  readonly parsed: unknown;
}

type RemoteScheme = "git" | "github" | "npm" | "registry";

type RemoteParentError = RecipeExtendsError | RecipeSourceError | RecipeManifestParseError;

const parentNotFound = (ref: string, chain: ReadonlyArray<string>): RecipeExtendsError =>
  new RecipeExtendsError({
    message: `Recipe parent "${ref}" was not found.`,
    chain: [...chain, ref],
    kind: "parent-not-found",
    remediation:
      "Point extends at a bundled recipe id or a local recipe directory that contains recipe.yml or recipe.ts.",
  });

const notFound = (ref: string): RecipeManifestNotFoundError =>
  new RecipeManifestNotFoundError({
    message: `Recipe parent "${ref}" was not found.`,
    source: ref,
  });

const detectRemoteScheme = (ref: string): RemoteScheme | undefined => {
  if (ref.startsWith("github:")) return "github";
  if (ref.startsWith("git+") || ref.startsWith("git@") || ref.startsWith("git://")) return "git";
  if (ref.startsWith("npm:")) return "npm";
  if (ref.startsWith("registry:")) return "registry";
  return undefined;
};

const parseGithubRef = (ref: string): { readonly url: string; readonly path?: string } => {
  const body = ref.slice("github:".length);
  const at = body.lastIndexOf("@");
  const withoutRef = at === -1 ? body : body.slice(0, at);
  const parts = withoutRef.split("/").filter((part) => part !== "");
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) throw notFound(ref);
  const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  return {
    url: `https://github.com/${owner}/${repo}.git`,
    ...(path === undefined || path === "" ? {} : { path }),
  };
};

const parseGitUrl = (ref: string): string => (ref.startsWith("git+") ? ref.slice("git+".length) : ref);

const parseNpmRef = (ref: string): { readonly package: string; readonly path?: string } => {
  const spec = ref.slice("npm:".length).trim();
  if (spec === "" || spec === "@") throw notFound(ref);

  let name: string;
  let afterName: string;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash <= 1) throw notFound(ref);
    const rest = spec.slice(slash + 1);
    const nameEnd = rest.search(/[/@]/u);
    const pkg = nameEnd === -1 ? rest : rest.slice(0, nameEnd);
    if (pkg === "") throw notFound(ref);
    name = `${spec.slice(0, slash)}/${pkg}`;
    afterName = nameEnd === -1 ? "" : rest.slice(nameEnd);
  } else {
    const nameEnd = spec.search(/[/@]/u);
    name = nameEnd === -1 ? spec : spec.slice(0, nameEnd);
    afterName = nameEnd === -1 ? "" : spec.slice(nameEnd);
    if (name === "") throw notFound(ref);
  }

  const at = afterName.lastIndexOf("@");
  const pathPart = at === -1 ? afterName : afterName.slice(0, at);
  const version = at === -1 ? undefined : afterName.slice(at + 1);
  const path = pathPart.startsWith("/") ? pathPart.slice(1) : pathPart;
  const packageSpec = version === undefined || version === "" ? name : `${name}@${version}`;
  return path === "" ? { package: packageSpec } : { package: packageSpec, path };
};

const parseRegistryId = (ref: string): string => {
  const id = ref.slice("registry:".length).trim();
  if (id === "") throw notFound(ref);
  return id;
};

const gitOptions = (url: string, path: string | undefined, ctx: RemoteParentContext) => ({
  url,
  ...(path === undefined ? {} : { path }),
  ...(ctx.userDataRoot === undefined ? {} : { userDataRoot: ctx.userDataRoot }),
  ...(ctx.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: ctx.gitRecipeCloner }),
});

const resolveRemote = async (
  ref: string,
  ctx: RemoteParentContext,
): Promise<{ readonly source: string; readonly manifestYaml: string }> => {
  const scheme = detectRemoteScheme(ref);
  if (scheme === undefined) throw notFound(ref);
  switch (scheme) {
    case "github": {
      const parsed = parseGithubRef(ref);
      return resolveGitRecipeSource(gitOptions(parsed.url, parsed.path, ctx));
    }
    case "git":
      return resolveGitRecipeSource(gitOptions(parseGitUrl(ref), undefined, ctx));
    case "npm": {
      const parsed = parseNpmRef(ref);
      return resolveNpmRecipeSource({
        package: parsed.package,
        ...(parsed.path === undefined ? {} : { path: parsed.path }),
        ...(ctx.userDataRoot === undefined ? {} : { userDataRoot: ctx.userDataRoot }),
      });
    }
    case "registry":
      return resolveRegistryRecipeSource({
        id: parseRegistryId(ref),
        ...(ctx.userDataRoot === undefined ? {} : { userDataRoot: ctx.userDataRoot }),
        ...(ctx.gitRecipeCloner === undefined ? {} : { gitRecipeCloner: ctx.gitRecipeCloner }),
      });
    default: {
      const _exhaustive: never = scheme;
      return _exhaustive;
    }
  }
};

const mapRemoteError = (cause: unknown, ref: string, chain: ReadonlyArray<string>): RemoteParentError => {
  if (cause instanceof RecipeManifestNotFoundError) return parentNotFound(ref, chain);
  if (cause instanceof RecipeSourceError) return cause;
  if (cause instanceof RecipeExtendsError) return cause;
  return new RecipeSourceError({
    message: cause instanceof Error ? cause.message : String(cause),
    source: ref,
    kind: "clone-failed",
    remediation: "Check that the remote recipe source is reachable and retry.",
  });
};

export const readRemoteParent = (
  ref: string,
  ctx: RemoteParentContext,
  chain: ReadonlyArray<string>,
): Effect.Effect<RawRemoteParent, RemoteParentError> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.tryPromise({
      try: () => resolveRemote(ref, ctx),
      catch: (cause) => mapRemoteError(cause, ref, chain),
    });
    return {
      source: resolved.source,
      parsed: yield* parseRecipeYaml({ source: resolved.source, content: resolved.manifestYaml }),
    };
  });
