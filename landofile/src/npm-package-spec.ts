import { RecipeSourceError } from "@lando/sdk/errors";

export interface ParsedNpmPackageSpec {
  readonly name: string;
  readonly version?: string;
}

const isSemverRangeSpecifier = (version: string): boolean => {
  const trimmed = version.trim();
  if (trimmed === "") return false;
  if (/^(?:\^|~|>=|<=|>|<|=)/u.test(trimmed)) return true;
  if (trimmed.includes("||") || /\s-\s/u.test(trimmed)) return true;
  return /^(?:x|\*)$/iu.test(trimmed) || /^\d+(?:\.\d+)?\s*\.\s*(?:x|\*)$/iu.test(trimmed);
};

export const parseNpmPackageSpec = (spec: string): ParsedNpmPackageSpec => {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf("@");
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  const version = at > 0 ? trimmed.slice(at + 1) : undefined;
  if (name === "" || name === "@" || (name.startsWith("@") && !name.includes("/"))) {
    throw new RecipeSourceError({
      message: `Invalid npm package spec "${spec}".`,
      source: spec,
      kind: "missing-package",
      remediation: "Pass --package=<name>[@version], e.g. --package=@lando/recipe-drupal@1.0.0.",
    });
  }
  if (version !== undefined && version !== "" && isSemverRangeSpecifier(version)) {
    throw new RecipeSourceError({
      message: `npm package spec "${spec}" uses a semver range in the version suffix; semver ranges are not supported.`,
      source: spec,
      kind: "version-not-found",
      remediation: "Pass an exact published version or a dist-tag such as latest or next.",
    });
  }
  return version === undefined || version === "" ? { name } : { name, version };
};
