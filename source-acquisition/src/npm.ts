import { SourceAcquisitionError } from "./errors.ts";

export interface NpmPackageDist {
  readonly tarball: string;
  readonly integrity?: string;
  readonly shasum?: string;
}

export interface NpmPackumentVersion {
  readonly dist: NpmPackageDist;
  readonly name?: string;
  readonly version?: string;
  readonly landoPlugin?: {
    readonly name?: string;
    readonly version?: string;
    readonly requires?: Readonly<Record<string, string>>;
  };
}

export interface NpmPackument {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, NpmPackumentVersion>>;
}

export interface ParsedNpmPackageSpec {
  readonly name: string;
  readonly version?: string;
}

export const isSemverRangeSpecifier = (version: string): boolean => {
  const trimmed = version.trim();
  if (trimmed === "") return false;
  if (/^(?:\^|~|>=|<=|>|<|=)/u.test(trimmed)) return true;
  if (trimmed.includes("||")) return true;
  if (/\s-\s/u.test(trimmed)) return true;
  if (/^(?:x|\*)$/iu.test(trimmed)) return true;
  return /^\d+(?:\.\d+)?\s*\.\s*(?:x|\*)$/iu.test(trimmed);
};

export const parseNpmPackageSpec = (spec: string): ParsedNpmPackageSpec => {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf("@");
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  const version = at > 0 ? trimmed.slice(at + 1) : undefined;
  if (name === "" || name === "@" || (name.startsWith("@") && !name.includes("/"))) {
    throw new SourceAcquisitionError({
      message: `Invalid npm package spec "${spec}".`,
      source: spec,
      kind: "invalid-locator",
      remediation:
        "Pass a package name with an optional exact version or dist-tag, e.g. @lando/plugin-php@1.0.0.",
    });
  }
  if (version !== undefined && version !== "" && isSemverRangeSpecifier(version)) {
    throw new SourceAcquisitionError({
      message: `npm package spec "${spec}" uses a semver range in the version suffix; semver ranges are not supported.`,
      source: spec,
      kind: "version-not-found",
      remediation: "Pass an exact published version or a dist-tag such as latest or next.",
    });
  }
  return version === undefined || version === "" ? { name } : { name, version };
};

export const resolveNpmPackageVersion = (
  packument: NpmPackument,
  requested: string | undefined,
  spec: string,
): string => {
  const distTags = packument["dist-tags"] ?? {};
  const versions = packument.versions ?? {};
  if (requested === undefined || requested === "") {
    const latest = distTags.latest;
    if (latest !== undefined && versions[latest] !== undefined) return latest;
    throw new SourceAcquisitionError({
      message: `npm package "${spec}" has no resolvable "latest" dist-tag.`,
      source: spec,
      kind: "version-not-found",
      remediation: "Pass an explicit package@version that the registry publishes.",
    });
  }
  const tagged = distTags[requested];
  if (tagged !== undefined && versions[tagged] !== undefined) return tagged;
  if (versions[requested] !== undefined) return requested;
  throw new SourceAcquisitionError({
    message: `npm package "${spec}" has no version or dist-tag matching "${requested}".`,
    source: spec,
    kind: "version-not-found",
    remediation: "Pass an exact published version or a valid dist-tag (e.g. latest, next).",
  });
};

export type { NpmRegistryTransport } from "./types.ts";
