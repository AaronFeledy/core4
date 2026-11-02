import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { RecipeManifestNotFoundError } from "@lando/sdk/errors";
import type { RecipeTransportEvidence } from "./resolved-source-types";
import type { ResolvedRecipe } from "./source";

export const recipeTransportEvidence = (resolved: ResolvedRecipe): RecipeTransportEvidence | undefined =>
  resolved.transport ??
  (resolved.commitSha !== undefined
    ? { kind: "git", commit: resolved.commitSha }
    : resolved.sha256 !== undefined
      ? { kind: "archive", digest: resolved.sha256 }
      : undefined);

export const recipePathEscapes = (candidate: string, root: string): boolean => {
  const local = relative(root, candidate);
  return isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`);
};

type RecipePathFailure<Kind extends "subpath-invalid" | "subpath-missing"> = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: Kind;
  readonly remediation: string;
}) => never;

export const normalizeRecipeSubpath = (
  subpath: string | undefined,
  wording: {
    readonly label: "Git" | "Tarball";
    readonly container: "cloned repository" | "extracted archive";
    readonly noun: "repository" | "archive";
  },
  fail: RecipePathFailure<"subpath-invalid">,
): string | undefined => {
  if (subpath === undefined || subpath.trim() === "" || subpath === ".") return undefined;
  const slashPath = subpath.replace(/\\/gu, "/");
  if (isAbsolute(subpath) || slashPath.startsWith("/")) {
    fail({
      message: `${wording.label} recipe --path must be relative and stay inside the ${wording.container}: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: `Pass a relative path inside the ${wording.noun}, such as --path=packages/foo.`,
    });
  }
  const normalized = relative(".", resolve(".", slashPath));
  if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    fail({
      message: `${wording.label} recipe --path escapes the ${wording.container}: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: `Pass a relative path inside the ${wording.noun}, such as --path=packages/foo.`,
    });
  }
  return normalized;
};

export const recipeUserDataRoot = async (override: string | undefined): Promise<string> => {
  if (override !== undefined) return override;
  return makeLandoPaths().roots.userDataRoot;
};

export const recipeFileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export const resolveRecipeManifest = async (input: {
  readonly publishedDir: string;
  readonly safeSubpath: string | undefined;
  readonly sourceKind: "git" | "tarball";
  readonly source: string;
  readonly fail: RecipePathFailure<"subpath-missing">;
}): Promise<{
  readonly recipeRoot: string;
  readonly manifestPath: string;
  readonly manifestYaml: string;
}> => {
  const { publishedDir, safeSubpath, sourceKind, source, fail } = input;
  const recipeRoot = safeSubpath === undefined ? publishedDir : join(publishedDir, safeSubpath);
  const manifestPath = join(recipeRoot, "recipe.yml");
  if (!(await recipeFileExists(manifestPath))) {
    if (safeSubpath !== undefined) {
      fail({
        message: `recipe.yml not found at ${sourceKind} recipe subpath ${safeSubpath}.`,
        source,
        kind: "subpath-missing",
        remediation: "Choose a --path that contains recipe.yml at its top level.",
      });
    }
    throw new RecipeManifestNotFoundError({
      message: `recipe.yml not found at ${manifestPath}.`,
      source: manifestPath,
    });
  }
  const local = relative(await realpath(publishedDir), await realpath(manifestPath));
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
    fail({
      message: `Recipe manifest escapes the published acquisition root: ${manifestPath}.`,
      source,
      kind: "subpath-missing",
      remediation: "Publish recipe.yml inside the acquired tree without an escaping symlink.",
    });
  }
  return {
    recipeRoot: await realpath(recipeRoot),
    manifestPath: await realpath(manifestPath),
    manifestYaml: await Bun.file(manifestPath).text(),
  };
};
