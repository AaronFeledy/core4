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
import { createHash } from "node:crypto";

import { RecipeSourceError } from "@lando/sdk/errors";

import type { ResolvedRecipe } from "./source.ts";
import {
  type TarballRecipeExtractor,
  type TarballRecipeFetcher,
  defaultTarballRecipeFetcher,
  resolveTarballRecipeSource,
} from "./tarball-source.ts";

export interface NpmPackageDist {
  readonly tarball: string;
  readonly integrity?: string;
  readonly shasum?: string;
}

export interface NpmPackumentVersion {
  readonly dist: NpmPackageDist;
}

export interface NpmPackument {
  readonly "dist-tags"?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, NpmPackumentVersion>>;
}

export interface NpmRegistryClient {
  // Returns the packument, or `undefined` when the package does not exist (404).
  readonly fetchPackument: (packageName: string) => Promise<NpmPackument | undefined>;
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

export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

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

const encodePackageName = (name: string): string =>
  name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

const defaultNpmRegistryClient = (registryUrl: string): NpmRegistryClient => ({
  fetchPackument: async (packageName) => {
    const base = registryUrl.replace(/\/+$/u, "");
    const response = await fetch(`${base}/${encodePackageName(packageName)}`, {
      headers: { accept: "application/json" },
      redirect: "follow",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return (await response.json()) as NpmPackument;
  },
});

const resolveVersion = (packument: NpmPackument, requested: string | undefined, spec: string): string => {
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

const verifyNpmIntegrity = (bytes: Uint8Array, dist: NpmPackageDist, source: string): void => {
  if (dist.integrity !== undefined && dist.integrity.trim() !== "") {
    const entry = dist.integrity.trim().split(/\s+/u)[0] ?? "";
    const dash = entry.indexOf("-");
    const algorithm = dash > 0 ? entry.slice(0, dash) : "";
    const expected = dash > 0 ? entry.slice(dash + 1) : "";
    if (algorithm === "" || expected === "") return;
    let actual: string;
    try {
      actual = createHash(algorithm).update(bytes).digest("base64");
    } catch {
      return; // unknown algorithm — treat as unverifiable rather than failing closed
    }
    if (actual !== expected) {
      throw sourceError({
        message: `npm tarball ${source} failed ${algorithm} integrity verification.`,
        source,
        kind: "integrity-mismatch",
        remediation:
          "The downloaded tarball does not match the registry integrity; retry or report the package.",
      });
    }
    return;
  }
  if (dist.shasum !== undefined && dist.shasum.trim() !== "") {
    const actual = createHash("sha1").update(bytes).digest("hex");
    if (actual.toLowerCase() !== dist.shasum.trim().toLowerCase()) {
      throw sourceError({
        message: `npm tarball ${source} failed sha1 shasum verification.`,
        source,
        kind: "integrity-mismatch",
        remediation:
          "The downloaded tarball does not match the registry shasum; retry or report the package.",
      });
    }
  }
  // Neither field present ⇒ no verification (warn-only policy, spec §PRD-B-07).
};

export const resolveNpmRecipeSource = async (
  options: ResolveNpmRecipeSourceOptions,
): Promise<ResolvedNpmRecipe> => {
  const { name, version } = parseNpmPackageSpec(options.package);
  const safeSubpath = normalizeNpmSubpath(options.path, options.package);
  const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
  const client = options.registryClient ?? defaultNpmRegistryClient(registryUrl);

  let packument: NpmPackument | undefined;
  try {
    packument = await client.fetchPackument(name);
  } catch (cause) {
    throw sourceError({
      message: `Could not fetch npm metadata for "${name}" from ${registryUrl}: ${causeMessage(cause)}`,
      source: options.package,
      kind: "registry-failed",
      remediation: "Check the registry URL and network access, then retry lando init.",
    });
  }
  if (packument === undefined) {
    throw sourceError({
      message: `npm package "${name}" was not found in the registry ${registryUrl}.`,
      source: options.package,
      kind: "package-not-found",
      remediation: "Check the package name (and scope) and retry lando init.",
    });
  }

  const resolvedVersion = resolveVersion(packument, version, options.package);
  const dist = packument.versions?.[resolvedVersion]?.dist;
  if (dist === undefined || dist.tarball === undefined || dist.tarball.trim() === "") {
    throw sourceError({
      message: `npm package "${name}@${resolvedVersion}" has no published tarball URL.`,
      source: options.package,
      kind: "version-not-found",
      remediation: "Pick a published version of this package, then retry lando init.",
    });
  }

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = await (options.fetcher ?? defaultTarballRecipeFetcher).fetch(dist.tarball);
  } catch (cause) {
    throw sourceError({
      message: `Could not download npm tarball ${dist.tarball}: ${causeMessage(cause)}`,
      source: dist.tarball,
      kind: "download-failed",
      remediation: "Check that the registry tarball URL is reachable and retry lando init.",
    });
  }

  verifyNpmIntegrity(archiveBytes, dist, dist.tarball);

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
    id: `${name}@${resolvedVersion}`,
    packageName: name,
    version: resolvedVersion,
    tarballUrl: dist.tarball,
  };
};
