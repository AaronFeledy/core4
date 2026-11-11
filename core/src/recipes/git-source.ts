/**
 * `git` recipe source resolver.
 *
 * Acquires a git tree through SourceSession (pinned commit under the shared
 * source cache), then resolves recipe.yml at the tree root or a monorepo --path.
 */
import { isLiteralGitRef } from "@lando/source-acquisition/locator";

import { RecipeSourceError } from "@lando/sdk/errors";
import { type SourceSession, displaySource } from "@lando/source-acquisition";

import type { ResolvedRecipe } from "./source";
import { runSourceSession } from "./source-session";
import { normalizeRecipeSubpath, resolveRecipeManifest } from "./source-support";

export interface ResolveGitRecipeSourceOptions {
  readonly url: string;
  readonly ref?: string;
  readonly onWarn?: (message: string) => void | Promise<void>;
  readonly path?: string;
  readonly sources: SourceSession;
  /** Aborts in-flight acquisition when the caller is cancelled. */
  readonly signal?: AbortSignal;
}

export interface ResolvedGitRecipe extends ResolvedRecipe {
  readonly commitSha: string;
}

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: "clone-failed" | "auth" | "subpath-missing" | "subpath-invalid" | "cache";
  readonly remediation: string;
}): RecipeSourceError =>
  new RecipeSourceError({
    ...input,
    message: displaySource(input.message),
    source: displaySource(input.source),
    remediation: displaySource(input.remediation),
  });

export const resolveGitRecipeSource = async (
  options: ResolveGitRecipeSourceOptions,
): Promise<ResolvedGitRecipe> => {
  if (options.ref !== undefined && !isLiteralGitRef(options.ref)) {
    throw sourceError({
      message: `Invalid git recipe ref: ${options.ref}`,
      source: options.url,
      kind: "clone-failed",
      remediation: "Choose a literal tag, branch, or full commit SHA.",
    });
  }
  const safeSubpath = normalizeRecipeSubpath(
    options.path,
    { label: "Git", container: "cloned repository", noun: "repository" },
    (input) => {
      throw sourceError(input);
    },
  );

  const snapshot = await runSourceSession(
    options.sources.acquireGit(
      {
        url: options.url,
        ...(options.ref === undefined ? {} : { ref: options.ref }),
      },
      {
        ...(options.onWarn === undefined
          ? {}
          : {
              onStaleFallback: (commit: string) =>
                options.onWarn?.(
                  `Could not refresh git recipe ${displaySource(options.url)}@${options.ref ?? "HEAD"}; using cached commit ${commit}.`,
                ),
            }),
      },
    ),
    "git",
    options.signal,
  );

  const commitSha = snapshot.pin.commit;

  const publishedDir = snapshot.root;
  const { recipeRoot, manifestPath, manifestYaml } = await resolveRecipeManifest({
    publishedDir,
    safeSubpath,
    sourceKind: "git",
    source: options.url,
    fail: (input) => {
      throw sourceError(input);
    },
  });

  return {
    id: options.url,
    source: manifestPath,
    manifestYaml,
    root: recipeRoot,
    acquisitionRoot: publishedDir,
    commitSha,
    transport: { kind: "git", commit: commitSha },
  };
};
