/**
 * `npm` recipe source resolver.
 *
 * Resolves an npm package's metadata through the registry, downloads the
 * published tarball, verifies its npm integrity (`dist.integrity` SRI or the
 * legacy `dist.shasum`), and reuses the shared `tarball` extractor to unpack it
 * under `<userDataRoot>/recipe-cache/tarball/<sha256>/`. npm tarballs nest every
 * file under a `package/` prefix, so the resolved recipe root is that `package/`
 * directory (plus an optional `--path` subpath).
 *
 * Version policy: an `@version` suffix is honored as an exact published version
 * or a dist-tag; with no suffix the registry's `latest` dist-tag is used.
 */
import { checkNpmPackageDistIntegrity } from "@lando/landofile/npm-integrity";

import type { NpmRecipeSourcePort } from "@lando/landofile/ports";
import { RecipeSourceError, causeMessage } from "@lando/sdk/errors";

import { defaultNpmRegistryClient } from "./npm-registry-client";
export { defaultNpmRegistryClient } from "./npm-registry-client";
import type { ResolvedRecipe } from "./source";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  defaultTarballRecipeFetcher,
  resolveTarballRecipeSource,
} from "./tarball-source";

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

export interface NpmRegistryClient {
  // Returns the packument. A missing package may resolve to `undefined` or fail with a RecipeSourceError that carries remediation.
  readonly fetchPackument: (packageName: string) => Promise<NpmPackument | undefined>;
  readonly fetchTarball?: (
    resolved: { readonly packageName: string; readonly dist: NpmPackageDist },
    fetcher?: TarballRecipeFetcher,
  ) => Promise<Uint8Array>;
}

export interface ParsedNpmPackageSpec {
  readonly name: string;
  readonly version?: string;
}

export interface ResolveNpmRecipeSourceOptions {
  readonly package: string;
  readonly path?: string;
  readonly registryUrl?: string;
  readonly userDataRoot?: string;
  readonly registryClient?: NpmRegistryClient;
  readonly fetcher?: TarballRecipeFetcher;
  readonly extractor?: TarballRecipeExtractor;
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
    | "subpath-invalid";
  readonly remediation: string;
}): RecipeSourceError => new RecipeSourceError(input);

const isSemverRangeSpecifier = (version: string): boolean => {
  const trimmed = version.trim();
  if (trimmed === "") return false;
  if (/^(?:\^|~|>=|<=|>|<|=)/u.test(trimmed)) return true;
  if (trimmed.includes("||")) return true;
  if (/\s-\s/u.test(trimmed)) return true;
  if (/^(?:x|\*)$/iu.test(trimmed)) return true;
  if (/^\d+(?:\.\d+)?\s*\.\s*(?:x|\*)$/iu.test(trimmed)) return true;
  return false;
};

/**
 * Splits an npm package spec into name + optional `@version`. The version
 * separator is the last `@` that is not the scope marker at index 0, so both
 * `@scope/pkg@1.2.3` and `pkg@1.2.3` parse correctly.
 */
export const parseNpmPackageSpec = (spec: string): ParsedNpmPackageSpec => {
  const trimmed = spec.trim();
  const at = trimmed.lastIndexOf("@");
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  const version = at > 0 ? trimmed.slice(at + 1) : undefined;
  if (name === "" || name === "@" || (name.startsWith("@") && !name.includes("/"))) {
    throw sourceError({
      message: `Invalid npm package spec "${spec}".`,
      source: spec,
      kind: "missing-package",
      remediation: "Pass --package=<name>[@version], e.g. --package=@lando/recipe-drupal@1.0.0.",
    });
  }
  if (version !== undefined && version !== "" && isSemverRangeSpecifier(version)) {
    throw sourceError({
      message: `npm package spec "${spec}" uses a semver range in the version suffix; semver ranges are not supported.`,
      source: spec,
      kind: "version-not-found",
      remediation: "Pass an exact published version or a dist-tag such as latest or next.",
    });
  }
  return version === undefined || version === "" ? { name } : { name, version };
};

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
    throw sourceError({
      message: `npm package "${spec}" has no resolvable "latest" dist-tag.`,
      source: spec,
      kind: "version-not-found",
      remediation: "Pass an explicit --package=<name>@<version> that the registry publishes.",
    });
  }
  const tagged = distTags[requested];
  if (tagged !== undefined && versions[tagged] !== undefined) return tagged;
  if (versions[requested] !== undefined) return requested;
  throw sourceError({
    message: `npm package "${spec}" has no version or dist-tag matching "${requested}".`,
    source: spec,
    kind: "version-not-found",
    remediation: "Pass an exact published version or a valid dist-tag (e.g. latest, next).",
  });
};

export const makeNpmRecipeSourcePort = (
  registryClient?: NpmRegistryClient | (() => NpmRegistryClient),
  registryUrl?: string,
  fetcher: TarballRecipeFetcher = defaultTarballRecipeFetcher,
): NpmRecipeSourcePort => {
  const clients = new WeakMap<Awaited<ReturnType<NpmRecipeSourcePort["resolve"]>>, NpmRegistryClient>();
  return {
    resolve: async (packageSpec) => {
      const client =
        typeof registryClient === "function"
          ? registryClient()
          : (registryClient ?? defaultNpmRegistryClient(registryUrl));
      const { name, version } = parseNpmPackageSpec(packageSpec);
      let packument: NpmPackument | undefined;
      try {
        packument = await client.fetchPackument(name);
      } catch (cause) {
        if (cause instanceof RecipeSourceError) throw cause;
        throw sourceError({
          message: `Could not fetch npm metadata for "${name}"${registryUrl === undefined ? "" : ` from ${registryUrl}`}: ${causeMessage(cause)}`,
          source: packageSpec,
          kind: "registry-failed",
          remediation: "Check the registry URL and network access, then retry lando init.",
        });
      }
      if (packument === undefined) {
        throw sourceError({
          message: `npm package "${name}" was not found in the registry${registryUrl === undefined ? "" : ` ${registryUrl}`}.`,
          source: packageSpec,
          kind: "package-not-found",
          remediation: "Check the package name (and scope) and retry lando init.",
        });
      }
      const resolvedVersion = resolveNpmPackageVersion(packument, version, packageSpec);
      const dist = packument.versions?.[resolvedVersion]?.dist;
      if (dist === undefined || typeof dist.tarball !== "string" || dist.tarball.trim() === "") {
        throw sourceError({
          message: `npm package "${name}@${resolvedVersion}" has no published tarball URL.`,
          source: packageSpec,
          kind: "version-not-found",
          remediation: "Pick a published version of this package, then retry lando init.",
        });
      }
      const resolved = { packageName: name, version: resolvedVersion, dist };
      clients.set(resolved, client);
      return resolved;
    },
    fetchTarball: async (resolved) => {
      const client = clients.get(resolved);
      if (client === undefined)
        throw sourceError({
          message: "Npm tarball metadata has no acquisition context.",
          source: resolved.packageName,
          kind: "registry-failed",
          remediation: "Resolve the package through this npm source port before fetching its tarball.",
        });
      return client.fetchTarball === undefined
        ? fetcher.fetch(resolved.dist.tarball)
        : client.fetchTarball(resolved, fetcher);
    },
  };
};

export const verifyNpmPackageDistIntegrity = (
  bytes: Uint8Array,
  dist: NpmPackageDist,
  source: string,
): void => {
  const integrity = checkNpmPackageDistIntegrity(bytes, dist);
  switch (integrity.status) {
    case "verified":
    case "unverifiable":
      return;
    case "mismatch":
      throw sourceError({
        message: `npm tarball ${source} ${integrity.description}`,
        source,
        kind: "integrity-mismatch",
        remediation: integrity.remediation,
      });
  }
};

export const resolveNpmRecipeSource = async (
  options: ResolveNpmRecipeSourceOptions,
): Promise<ResolvedNpmRecipe> => {
  const safeSubpath = normalizeNpmSubpath(options.path, options.package);
  const registryUrl = options.registryUrl;
  const client = options.registryClient ?? defaultNpmRegistryClient(registryUrl);
  const resolvedPackage = await makeNpmRecipeSourcePort(client, registryUrl).resolve(options.package);
  const { packageName, version, dist } = resolvedPackage;

  let archiveBytes: Uint8Array;
  try {
    archiveBytes =
      client.fetchTarball === undefined
        ? await (options.fetcher ?? defaultTarballRecipeFetcher).fetch(dist.tarball)
        : await client.fetchTarball(resolvedPackage, options.fetcher);
  } catch (cause) {
    if (cause instanceof RecipeSourceError) throw cause;
    throw sourceError({
      message: `Could not download npm tarball ${dist.tarball}: ${causeMessage(cause)}`,
      source: dist.tarball,
      kind: "download-failed",
      remediation: "Check that the registry tarball URL is reachable and retry lando init.",
    });
  }

  verifyNpmPackageDistIntegrity(archiveBytes, dist, dist.tarball);

  // npm tarballs nest content under `package/`; delegate to the shared tarball
  // resolver (pre-downloaded bytes) so the extractor / cache / subpath logic is
  // reused verbatim.
  const tarballPath = safeSubpath === undefined ? "package" : `package/${safeSubpath}`;
  const resolved = await resolveTarballRecipeSource({
    url: dist.tarball,
    path: tarballPath,
    fetcher: { fetch: async () => archiveBytes },
    ...(options.userDataRoot === undefined ? {} : { userDataRoot: options.userDataRoot }),
    ...(options.extractor === undefined ? {} : { extractor: options.extractor }),
  });

  return {
    ...resolved,
    id: `${packageName}@${version}`,
    packageName,
    version,
    tarballUrl: dist.tarball,
  };
};
