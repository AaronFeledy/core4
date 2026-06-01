/**
 * `tarball` recipe source resolver.
 *
 * Downloads a `https://…` (or any `fetch`-able) archive, verifies its SHA-256,
 * extracts it under `<userDataRoot>/recipe-cache/tarball/<sha256>/`, and
 * resolves `recipe.yml` at the archive top level (or a monorepo `--path`
 * subpath). Mirrors the `git` source's cache/publish/subpath discipline.
 *
 * Checksum policy:
 *   - `--checksum=<hash>` supplied → SHA-256 is REQUIRED; a mismatch fails with
 *     a tagged `checksum-mismatch` error before anything is extracted.
 *   - no checksum → warn-only; when an interactive confirm seam is supplied
 *     (i.e. not `--yes`/`--no-interactive`) the user is prompted once and a
 *     decline aborts with `checksum-unverified`.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { Effect } from "effect";

import { RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { ConfigServiceLive } from "../services/config.ts";
import { publish } from "./git-source.ts";
import type { ResolvedRecipe } from "./source.ts";

export interface TarballRecipeFetcher {
  readonly fetch: (url: string) => Promise<Uint8Array>;
}

export interface TarballRecipeExtractor {
  readonly extract: (archiveBytes: Uint8Array, destDir: string) => Promise<void>;
}

export interface ResolveTarballRecipeSourceOptions {
  readonly url: string;
  readonly path?: string;
  readonly checksum?: string;
  readonly userDataRoot?: string;
  readonly fetcher?: TarballRecipeFetcher;
  readonly extractor?: TarballRecipeExtractor;
  // Emitted once with the computed SHA-256 when no `--checksum` was supplied.
  readonly onWarn?: (message: string) => void;
  // Interactive confirmation seam for the unverified-checksum case. Returning
  // `false` aborts the init. Absent ⇒ warn-only (i.e. `--yes`/non-interactive).
  readonly confirmUnverified?: (sha256: string) => Promise<boolean>;
}

export interface ResolvedTarballRecipe extends ResolvedRecipe {
  readonly sha256: string;
}

const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind:
    | "download-failed"
    | "checksum-mismatch"
    | "checksum-unverified"
    | "extract-failed"
    | "subpath-invalid"
    | "subpath-missing"
    | "cache";
  readonly remediation: string;
}): RecipeSourceError => new RecipeSourceError(input);

const SHA256_RE = /^[0-9a-f]{64}$/u;
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const normalizeSubpath = (subpath: string | undefined): string | undefined => {
  if (subpath === undefined || subpath.trim() === "" || subpath === ".") return undefined;
  const slashPath = subpath.replace(/\\/gu, "/");
  if (isAbsolute(subpath) || slashPath.startsWith("/")) {
    throw sourceError({
      message: `Tarball recipe --path must be relative and stay inside the extracted archive: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: "Pass a relative path inside the archive, such as --path=packages/foo.",
    });
  }
  const normalized = relative(".", resolve(".", slashPath));
  if (normalized === "" || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw sourceError({
      message: `Tarball recipe --path escapes the extracted archive: ${subpath}`,
      source: subpath,
      kind: "subpath-invalid",
      remediation: "Pass a relative path inside the archive, such as --path=packages/foo.",
    });
  }
  return normalized;
};

const userDataRoot = async (override: string | undefined): Promise<string> => {
  if (override !== undefined) return override;
  const resolved = await Effect.runPromise(
    Effect.flatMap(ConfigService, (config) => config.get("userDataRoot")).pipe(
      Effect.provide(ConfigServiceLive),
    ),
  );
  if (resolved === undefined) throw new Error("ConfigService returned no userDataRoot.");
  return resolved;
};

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export const defaultTarballRecipeFetcher: TarballRecipeFetcher = {
  fetch: async (url) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

const isGzip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

const TAR_BLOCK = 512;

/**
 * Safe relative path for a tar entry: forward-slash normalized, leading slashes
 * and `.` segments dropped, and any `..` segment rejects the whole archive
 * (path-traversal guard, mirroring the git subpath invariant).
 */
const safeEntryPath = (entryName: string, source: string): string => {
  const segments = entryName
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw sourceError({
      message: `Tarball entry escapes the extraction directory: ${entryName}`,
      source,
      kind: "extract-failed",
      remediation: "The archive contains an unsafe path; re-publish it without parent-directory entries.",
    });
  }
  return segments.join("/");
};

/**
 * Minimal in-memory tar(.gz) extractor (ustar + GNU longname). The whole
 * archive is buffered — recipe tarballs are small. Regular files and
 * directories are written; links/devices/PAX headers are skipped.
 */
const extractTarballToDirImpl = async (
  archiveBytes: Uint8Array,
  destDir: string,
  source: string,
): Promise<void> => {
  const tar = isGzip(archiveBytes) ? gunzipSync(Buffer.from(archiveBytes)) : Buffer.from(archiveBytes);
  await mkdir(destDir, { recursive: true });
  let pos = 0;
  let longName: string | undefined;
  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK);
    if (header[0] === 0) break; // end-of-archive sentinel
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    const name = Buffer.from(header.subarray(0, nameEnd)).toString("utf8");
    let prefixEnd = 0;
    while (prefixEnd < 155 && header[345 + prefixEnd] !== 0) prefixEnd += 1;
    const prefix = Buffer.from(header.subarray(345, 345 + prefixEnd)).toString("utf8");
    const sizeOctal = Buffer.from(header.subarray(124, 136))
      .toString("ascii")
      .replace(/[^0-7]/gu, "");
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    const typeflag = header[156];
    pos += TAR_BLOCK;
    const dataStart = pos;
    pos += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === 76 /* 'L' GNU longname */) {
      longName = Buffer.from(tar.subarray(dataStart, dataStart + size))
        .toString("utf8")
        .replace(/\0+$/u, "");
      continue;
    }
    if (typeflag === 120 /* 'x' */ || typeflag === 103 /* 'g' PAX */) {
      longName = undefined;
      continue;
    }

    const fullName = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    longName = undefined;
    const safeRel = safeEntryPath(fullName, source);
    if (safeRel === "") continue;
    const target = join(destDir, safeRel);

    const isDir = typeflag === 53 /* '5' */ || fullName.endsWith("/");
    if (isDir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (typeflag === 0 || typeflag === 48 /* '0' regular */) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(dataStart, dataStart + size));
    }
    // links/devices/fifos are skipped intentionally.
  }
};

const defaultTarballRecipeExtractor: TarballRecipeExtractor = {
  extract: (archiveBytes, destDir) => extractTarballToDirImpl(archiveBytes, destDir, "tarball"),
};

export const resolveTarballRecipeSource = async (
  options: ResolveTarballRecipeSourceOptions,
): Promise<ResolvedTarballRecipe> => {
  const safeSubpath = normalizeSubpath(options.path);
  const expectedChecksum = options.checksum?.trim().toLowerCase();

  const root = await userDataRoot(options.userDataRoot).catch((cause) => {
    throw sourceError({
      message: `Could not resolve the Lando user data root for tarball recipe caching: ${causeMessage(cause)}`,
      source: "tarball",
      kind: "cache",
      remediation: "Set LANDO_USER_DATA_ROOT or fix the Lando config file, then retry lando init.",
    });
  });
  const cacheRoot = join(root, "recipe-cache", "tarball");
  await mkdir(cacheRoot, { recursive: true }).catch((cause) => {
    throw sourceError({
      message: `Could not create tarball recipe cache at ${cacheRoot}: ${causeMessage(cause)}`,
      source: options.url,
      kind: "cache",
      remediation: "Check permissions for the Lando user data root and retry lando init.",
    });
  });

  let archiveBytes: Uint8Array;
  try {
    archiveBytes = await (options.fetcher ?? defaultTarballRecipeFetcher).fetch(options.url);
  } catch (cause) {
    throw sourceError({
      message: `Could not download tarball recipe source ${options.url}: ${causeMessage(cause)}`,
      source: options.url,
      kind: "download-failed",
      remediation: "Check that the tarball URL is reachable and retry lando init.",
    });
  }

  const sha256 = sha256Hex(archiveBytes);

  if (expectedChecksum !== undefined && expectedChecksum !== "") {
    if (!SHA256_RE.test(expectedChecksum)) {
      throw sourceError({
        message: `--checksum must be a 64-character hex SHA-256 digest: ${options.checksum}`,
        source: options.url,
        kind: "checksum-mismatch",
        remediation: "Pass --checksum=<sha256> as 64 lowercase hex characters.",
      });
    }
    if (sha256 !== expectedChecksum) {
      throw sourceError({
        message: `Tarball recipe SHA-256 mismatch for ${options.url}: expected ${expectedChecksum}, got ${sha256}.`,
        source: options.url,
        kind: "checksum-mismatch",
        remediation: "Verify the --checksum value or re-download the tarball; the archive was not extracted.",
      });
    }
  } else {
    options.onWarn?.(
      `No --checksum supplied for tarball recipe ${options.url}; downloaded SHA-256 is ${sha256}. Pass --checksum=<sha256> to verify the archive on future runs.`,
    );
    if (options.confirmUnverified !== undefined) {
      const confirmed = await options.confirmUnverified(sha256);
      if (!confirmed) {
        throw sourceError({
          message: `Tarball recipe ${options.url} was not verified (no --checksum) and the prompt was declined.`,
          source: options.url,
          kind: "checksum-unverified",
          remediation: "Re-run with --checksum=<sha256> to verify the archive, or accept the prompt.",
        });
      }
    }
  }

  const publishedDir = join(cacheRoot, sha256);
  if (!(await fileExists(publishedDir))) {
    const stagingDir = await mkdtemp(join(cacheRoot, ".staging-"));
    try {
      await (options.extractor ?? defaultTarballRecipeExtractor).extract(archiveBytes, stagingDir);
    } catch (cause) {
      await rm(stagingDir, { recursive: true, force: true });
      if (cause instanceof RecipeSourceError) throw cause;
      throw sourceError({
        message: `Could not extract tarball recipe source ${options.url}: ${causeMessage(cause)}`,
        source: options.url,
        kind: "extract-failed",
        remediation: "The archive could not be read as a tar/tar.gz; check the URL points at a tarball.",
      });
    }
    await publish(stagingDir, publishedDir).catch(async (cause) => {
      await rm(stagingDir, { recursive: true, force: true });
      throw sourceError({
        message: `Could not publish tarball recipe cache at ${publishedDir}: ${causeMessage(cause)}`,
        source: options.url,
        kind: "cache",
        remediation: "Check permissions for the Lando user data root and retry lando init.",
      });
    });
  }

  const recipeRoot = safeSubpath === undefined ? publishedDir : join(publishedDir, safeSubpath);
  const manifestPath = join(recipeRoot, "recipe.yml");
  if (!(await fileExists(manifestPath))) {
    if (safeSubpath !== undefined) {
      throw sourceError({
        message: `recipe.yml not found at tarball recipe subpath ${safeSubpath}.`,
        source: options.url,
        kind: "subpath-missing",
        remediation: "Choose a --path that contains recipe.yml at its top level.",
      });
    }
    throw new RecipeManifestNotFoundError({
      message: `recipe.yml not found at ${manifestPath}.`,
      source: manifestPath,
    });
  }

  return {
    id: options.url,
    source: manifestPath,
    manifestYaml: await Bun.file(manifestPath).text(),
    root: recipeRoot,
    sha256,
  };
};
