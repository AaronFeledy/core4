import { tryPromiseSettled } from "@lando/sdk/abortable-promise";
import {
  RecipeExtendsError,
  RecipeManifestNotFoundError,
  type RecipeManifestParseError,
  RecipeSourceError,
  causeMessage,
} from "@lando/sdk/errors";
import type { SourceSession } from "@lando/source-acquisition";
import { gitCloneUrl, splitSourceRef } from "@lando/source-acquisition/locator";
import { Effect } from "effect";
import { resolveGitRecipeSource } from "../git-source";
import { resolveNpmRecipeSource } from "../npm-source";
import { resolveRegistryRecipeSource } from "../registry-source";
import type { RecipeTransportEvidence } from "../resolved-source-types";
import type { ResolvedRecipe } from "../source";
import { recipeTransportEvidence } from "../source-support";
import { parseRecipeYaml } from "./parser";

export interface RemoteParentContext {
  readonly onWarn?: (message: string) => void | Promise<void>;
  readonly sources: SourceSession;
  readonly signal?: AbortSignal;
  readonly registryUrl?: string;
}

export interface RawRemoteParent {
  readonly source: string;
  readonly parsed: unknown;
  readonly acquisitionRoot?: string;
  readonly content: string;
  readonly evaluation: "declarative";
  readonly transport?: RecipeTransportEvidence;
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

const parseGithubRef = (
  ref: string,
): { readonly url: string; readonly path?: string; readonly ref?: string } => {
  const split = splitSourceRef(ref);
  const parts = split.value
    .slice("github:".length)
    .split("/")
    .filter((part) => part !== "");
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) throw notFound(ref);
  const path = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  return {
    url: `https://github.com/${owner}/${repo}.git`,
    ...(split.ref === undefined ? {} : { ref: split.ref }),
    ...(path === undefined ? {} : { path }),
  };
};

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

const resolveRemote = async (ref: string, ctx: RemoteParentContext): Promise<ResolvedRecipe> => {
  const scheme = detectRemoteScheme(ref);
  if (scheme === undefined) throw notFound(ref);
  switch (scheme) {
    case "github": {
      const parsed = parseGithubRef(ref);
      return resolveGitRecipeSource({
        url: parsed.url,
        sources: ctx.sources,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(parsed.path === undefined ? {} : { path: parsed.path }),
        ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        ...(ctx.onWarn === undefined ? {} : { onWarn: ctx.onWarn }),
      });
    }
    case "git": {
      const parsed = splitSourceRef(ref);
      return resolveGitRecipeSource({
        url: gitCloneUrl(parsed.value),
        sources: ctx.sources,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
        ...(ctx.onWarn === undefined ? {} : { onWarn: ctx.onWarn }),
      });
    }
    case "npm": {
      const parsed = parseNpmRef(ref);
      return resolveNpmRecipeSource({
        package: parsed.package,
        sources: ctx.sources,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(parsed.path === undefined ? {} : { path: parsed.path }),
      });
    }
    case "registry":
      return resolveRegistryRecipeSource({
        id: parseRegistryId(ref),
        sources: ctx.sources,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(ctx.registryUrl === undefined ? {} : { registryUrl: ctx.registryUrl }),
        ...(ctx.onWarn === undefined ? {} : { onWarn: ctx.onWarn }),
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
    message: causeMessage(cause),
    source: ref,
    kind: "clone-failed",
    remediation: "Check that the remote recipe source is reachable and retry.",
  });
};

export const readRemoteParent = Effect.fn("RecipeManifest.readRemoteParent")(function* (
  ref: string,
  ctx: RemoteParentContext,
  chain: ReadonlyArray<string>,
): Effect.fn.Return<RawRemoteParent, RemoteParentError> {
  // Join the aborted acquisition so its staging cleanup finishes before the session lease closes.
  const resolved = yield* tryPromiseSettled({
    try: (signal) =>
      resolveRemote(ref, {
        ...ctx,
        signal: ctx.signal === undefined ? signal : AbortSignal.any([ctx.signal, signal]),
      }),
    catch: (cause) => mapRemoteError(cause, ref, chain),
  });
  const transport = recipeTransportEvidence(resolved);
  return {
    source: resolved.source,
    parsed: yield* parseRecipeYaml({ source: resolved.source, content: resolved.manifestYaml }),
    content: resolved.manifestYaml,
    evaluation: "declarative",
    ...(transport === undefined ? {} : { transport }),
    ...(resolved.acquisitionRoot === undefined ? {} : { acquisitionRoot: resolved.acquisitionRoot }),
  };
});
