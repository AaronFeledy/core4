/**
 * `npm` recipe source resolver.
 *
 * Resolves and materializes through SourceSession.acquireNpm (shared archive
 * entry + npm index). npm tarballs nest under package/; the recipe root is that
 * package/ directory plus an optional --path subpath.
 *
 * Integrity: missing integrity/shasum fails (store policy).
 */
import { join } from "node:path";

import { type SourceSession, displaySource } from "@lando/source-acquisition";
import { parseNpmPackageSpec } from "@lando/source-acquisition/npm";

import { RecipeSourceError, causeMessage } from "@lando/sdk/errors";

import type { ResolvedRecipe } from "./source";
import { mapSourceAcquisitionError, runSourceSession } from "./source-session";
import { resolveRecipeManifest } from "./source-support";

export interface ResolveNpmRecipeSourceOptions {
  readonly package: string;
  readonly path?: string;
  readonly sources: SourceSession;
  /** Aborts in-flight acquisition when the caller is cancelled. */
  readonly signal?: AbortSignal;
}

export interface ResolvedNpmRecipe extends ResolvedRecipe {
  readonly packageName: string;
  readonly version: string;
  readonly tarballUrl: string;
  readonly sha256: string;
}

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind:
    | "missing-package"
    | "registry-failed"
    | "package-not-found"
    | "version-not-found"
    | "integrity-mismatch"
    | "download-failed"
    | "subpath-invalid"
    | "subpath-missing"
    | "cache";
  readonly remediation: string;
}): RecipeSourceError =>
  new RecipeSourceError({
    ...input,
    message: displaySource(input.message),
    source: displaySource(input.source),
    remediation: displaySource(input.remediation),
  });

const normalizeNpmSubpath = (subpath: string | undefined, source: string): string | undefined => {
  if (subpath === undefined || subpath.trim() === "" || subpath === ".") return undefined;
  const slashPath = subpath.replace(/\\/gu, "/");
  const segments = slashPath.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (slashPath.startsWith("/") || segments.some((segment) => segment === "..")) {
    throw sourceError({
      message: `Npm recipe --path must be relative and stay inside the package: ${subpath}`,
      source,
      kind: "subpath-invalid",
      remediation: "Pass a relative path inside the package, such as --path=recipes/foo.",
    });
  }
  return segments.length === 0 ? undefined : segments.join("/");
};

export const resolveNpmRecipeSource = async (
  options: ResolveNpmRecipeSourceOptions,
): Promise<ResolvedNpmRecipe> => {
  const safeSubpath = normalizeNpmSubpath(options.path, options.package);
  let name: string;
  let selector: string | undefined;
  try {
    const parsed = parseNpmPackageSpec(options.package);
    name = parsed.name;
    selector = parsed.version;
  } catch (cause) {
    throw mapSourceAcquisitionError(cause, "npm");
  }

  const snapshot = await runSourceSession(
    options.sources.acquireNpm({
      name,
      ...(selector === undefined ? {} : { selector }),
    }),
    "npm",
    options.signal,
  );

  const packageName = snapshot.pin.name;
  const version = snapshot.pin.version;
  const tarballUrl = snapshot.pin.dist.tarball;
  const sha256 = snapshot.key.kind === "archive" ? snapshot.key.sha256 : "";

  const publishedDir = join(snapshot.root, "package");

  const { recipeRoot, manifestPath, manifestYaml } = await resolveRecipeManifest({
    publishedDir,
    safeSubpath,
    sourceKind: "tarball",
    source: options.package,
    fail: (input) => {
      throw sourceError(input);
    },
  }).catch((cause) => {
    if (cause instanceof RecipeSourceError) throw cause;
    throw sourceError({
      message: `Could not resolve npm recipe manifest for ${options.package}: ${causeMessage(cause)}`,
      source: options.package,
      kind: "package-not-found",
      remediation: "Ensure the package publishes recipe.yml under package/ (or the given --path).",
    });
  });

  return {
    id: `${packageName}@${version}`,
    source: manifestPath,
    manifestYaml,
    root: recipeRoot,
    // Jail is the full archive tree so package/.. cannot escape the snapshot.
    acquisitionRoot: snapshot.root,
    packageName,
    version,
    tarballUrl,
    sha256,
    ...(sha256 === "" ? {} : { transport: { kind: "archive" as const, digest: sha256 } }),
  };
};
