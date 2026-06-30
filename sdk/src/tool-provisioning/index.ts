/**
 * `@lando/sdk/tool-provisioning` — the shared verify→extract→install helper for
 * bundled tools that ship a pinned host binary (Mutagen today; tunnel/mkcert/
 * profiler/RemoteSource CLIs later).
 *
 * It is a PURE module on the contracts tier (like `@lando/sdk/probe` and
 * `@lando/sdk/secrets`): not an Effect service tag and not a pluggable plugin
 * abstraction seam. Host-override of network behavior happens one layer down at the
 * `Downloader`; this helper is fixed so every bundled tool installs identically.
 * It consumes the `Downloader` service (verified bytes) and `node:fs` (placement).
 *
 * Resolution: the helper installs ONE explicit artifact `key` per call. A tool
 * that installs several binaries from one pinned release (e.g. Mutagen's host
 * CLI plus per-platform agents) calls the helper once per key; entries that
 * share a `url`/`sha256` reuse the same cached archive, so the byte cache
 * de-duplicates the download.
 *
 * Extraction (`member`): a member selector may cross exactly one nested
 * supported-archive boundary, e.g. `mutagen-agents.tar.gz/linux_amd64` means
 * "extract `mutagen-agents.tar.gz` from the outer archive, then `linux_amd64`
 * from that nested tar.gz". A flat `member` (`mutagen`) is a one-stage extract.
 * An omitted `archive` means the downloaded bytes are the binary itself.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { Effect, type Scope } from "effect";

import { ToolExtractError, ToolInstallPathError, ToolManifestError } from "../errors/index.ts";
import type { ToolManifest } from "../schema/index.ts";
import { type DownloadError, Downloader } from "../services/index.ts";

const DEFAULT_MODE = 0o755;
const NESTED_ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".zip"] as const;

export interface ProvisionToolInput {
  /** The pinned tool manifest (the canonical `ToolManifest`). */
  readonly manifest: ToolManifest;
  /** The explicit `artifacts` key to provision (host key or a structured key). */
  readonly key: string;
  /** Tool id; namespaces the version marker and tags the `Downloader` caller. */
  readonly toolId: string;
  /** Resolved `<userDataRoot>/bin` directory (the SDK stays core-free). */
  readonly binDir: string;
  /** Resolved `<userCacheRoot>/tool-downloads/<toolId>` cache directory. */
  readonly toolDownloadsDir: string;
  /** Host platform; controls the executable-bit application. Default `process.platform`. */
  readonly platform?: string | undefined;
  /** Re-provision even when the version marker + fingerprint already match. */
  readonly force?: boolean | undefined;
  /** Pass-through to the `Downloader`; fails when the artifact is not cached. */
  readonly offline?: boolean | undefined;
}

export interface InstalledTool {
  readonly key: string;
  readonly installPath: string;
  readonly toolVersion: string;
  /** SHA-256 of the installed binary (post-extract). */
  readonly sha256: string;
  /** Whether the verified archive was a `Downloader` cache hit. */
  readonly fromCache: boolean;
  /** True when the version marker + fingerprint already matched (no work, no network). */
  readonly skipped: boolean;
}

export type ToolError = ToolManifestError | ToolExtractError | ToolInstallPathError | DownloadError;

/** Map a host platform + arch to the canonical `${platform}-${arch}` manifest key. */
export const resolveHostKey = (platform: string, arch: string): string => `${platform}-${arch}`;

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const versionMarkerPath = (binDir: string, toolId: string): string => join(binDir, `.${toolId}.version`);

const legacyVersionMarkerPath = (binDir: string, toolId: string): string =>
  join(binDir, `.${toolId}-installed-version`);

const readVersionMarkerFile = async (path: string): Promise<string | undefined> => {
  try {
    const content = (await readFile(path, "utf-8")).trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
};

const readInstalledToolVersionMarker = async (
  binDir: string,
  toolId: string,
): Promise<string | undefined> => {
  for (const path of [versionMarkerPath(binDir, toolId), legacyVersionMarkerPath(binDir, toolId)]) {
    const content = await readVersionMarkerFile(path);
    if (content !== undefined) return content;
  }
  return undefined;
};

const fingerprintPath = (installPath: string): string => `${installPath}.sha256`;

const isContained = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel.length === 0 || (!rel.startsWith(`..${"/"}`) && !rel.startsWith("..\\") && !isAbsolute(rel));
};

/**
 * Resolve `installName` to an absolute path strictly contained under the
 * realpath of `binDir`. Subdirectories (e.g. `mutagen-agents/...`) are allowed;
 * any name that escapes the install root is rejected.
 */
const resolveContainedInstallPath = (
  binDir: string,
  toolId: string,
  installName: string,
): { ok: true; path: string } | { ok: false; error: ToolInstallPathError } => {
  if (installName.length === 0 || installName.includes("\0") || isAbsolute(installName)) {
    return {
      ok: false,
      error: new ToolInstallPathError({
        message: `Install name "${installName}" is not a relative path within the bin directory.`,
        toolId,
        installName,
        remediation: "Use a relative install name contained within the bin directory.",
      }),
    };
  }
  const root = resolve(binDir);
  const resolved = resolve(root, installName);
  const rel = relative(root, resolved);
  if (rel.length === 0 || !isContained(root, resolved)) {
    return {
      ok: false,
      error: new ToolInstallPathError({
        message: `Install name "${installName}" escapes the bin directory.`,
        toolId,
        installName,
        remediation: "Use an install name contained within the bin directory.",
      }),
    };
  }
  return { ok: true, path: resolved };
};

const ensureRealpathContainedInstallParent = (
  input: ProvisionToolInput,
  installPath: string,
): Effect.Effect<void, ToolInstallPathError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(input.binDir, { recursive: true });
      const installDir = dirname(installPath);
      await mkdir(installDir, { recursive: true });
      const [rootRealpath, installDirRealpath] = await Promise.all([
        realpath(input.binDir),
        realpath(installDir),
      ]);
      if (!isContained(rootRealpath, installDirRealpath)) {
        throw new ToolInstallPathError({
          message: `Install name "${input.manifest.artifacts[input.key]?.installName ?? input.key}" escapes the bin directory through a symlinked parent.`,
          toolId: input.toolId,
          installName: input.manifest.artifacts[input.key]?.installName,
          remediation:
            "Use an install path whose real parent directory is contained within the bin directory.",
        });
      }
    },
    catch: (cause) =>
      cause instanceof ToolInstallPathError
        ? cause
        : new ToolInstallPathError({
            message: `Failed to verify the install path for "${input.key}" is contained within the bin directory.`,
            toolId: input.toolId,
            installName: input.manifest.artifacts[input.key]?.installName,
            remediation: "Ensure the bin directory exists and is accessible, then retry `lando setup`.",
            cause,
          }),
  });

/** Extract a named regular-file member from a (decompressed) POSIX tar buffer. */
const extractTarMember = (tar: Uint8Array, member: string): Uint8Array | undefined => {
  const BLOCK = 512;
  let pos = 0;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header[0] === 0) break; // end-of-archive
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const entryName = Buffer.from(header.subarray(0, nameEnd)).toString("latin1");
    const sizeOctal = Buffer.from(header.subarray(124, 136))
      .toString("ascii")
      .replace(/[^0-7]/gu, "");
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    pos += BLOCK;
    if (entryName === member || basename(entryName) === member) {
      return tar.subarray(pos, pos + size);
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  return undefined;
};

const extractTarGzMember = (archive: Uint8Array, member: string): Uint8Array | undefined =>
  extractTarMember(new Uint8Array(gunzipSync(Buffer.from(archive))), member);

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

interface ZipCentralEntry {
  readonly compression: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

const readZipCentralDirectory = (archive: Uint8Array): Map<number, ZipCentralEntry> => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let pos = archive.length - 22; pos >= 0; pos--) {
    if (view.getUint32(pos, true) !== ZIP_EOCD) continue;
    const cdOffset = view.getUint32(pos + 16, true);
    const cdSize = view.getUint32(pos + 12, true);
    const cdEnd = cdOffset + cdSize;
    const entries = new Map<number, ZipCentralEntry>();
    let cd = cdOffset;
    while (cd + 46 <= cdEnd) {
      if (view.getUint32(cd, true) !== ZIP_CENTRAL_HEADER) break;
      const compression = view.getUint16(cd + 10, true);
      const compressedSize = view.getUint32(cd + 20, true);
      const uncompressedSize = view.getUint32(cd + 24, true);
      const filenameLen = view.getUint16(cd + 28, true);
      const extraLen = view.getUint16(cd + 30, true);
      const commentLen = view.getUint16(cd + 32, true);
      const localOffset = view.getUint32(cd + 42, true);
      entries.set(localOffset, { compression, compressedSize, uncompressedSize });
      cd += 46 + filenameLen + extraLen + commentLen;
    }
    return entries;
  }
  return new Map();
};

const extractZipMember = (archive: Uint8Array, member: string): Uint8Array | undefined => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const central = readZipCentralDirectory(archive);
  let pos = 0;
  while (pos + 30 <= archive.length) {
    if (view.getUint32(pos, true) !== ZIP_LOCAL_HEADER) break;
    const flags = view.getUint16(pos + 6, true);
    const headerCompression = view.getUint16(pos + 8, true);
    const headerCompressedSize = view.getUint32(pos + 18, true);
    const headerUncompressedSize = view.getUint32(pos + 22, true);
    const filenameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const filename = new TextDecoder("utf-8").decode(archive.subarray(pos + 30, pos + 30 + filenameLen));
    const dataOffset = pos + 30 + filenameLen + extraLen;
    const indexed = central.get(pos);
    const compression = indexed?.compression ?? headerCompression;
    const compressedSize = indexed?.compressedSize ?? headerCompressedSize;
    const uncompressedSize = indexed?.uncompressedSize ?? headerUncompressedSize;
    if (filename === member || basename(filename) === member) {
      if (compression === 0) return archive.subarray(dataOffset, dataOffset + uncompressedSize);
      if (compression === 8) {
        return new Uint8Array(
          inflateRawSync(Buffer.from(archive.subarray(dataOffset, dataOffset + compressedSize))),
        );
      }
      return undefined;
    }
    const descriptorLength =
      (flags & 0x08) !== 0 ? zipDescriptorLength(view, archive, dataOffset + compressedSize) : 0;
    pos = dataOffset + compressedSize + descriptorLength;
  }
  return undefined;
};

const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const zipDescriptorLength = (view: DataView, archive: Uint8Array, offset: number): number => {
  if (offset + 4 > archive.length) return 12;
  return view.getUint32(offset, true) === ZIP_DATA_DESCRIPTOR ? 16 : 12;
};

const archiveKindFor = (suffix: string): "tar.gz" | "zip" | undefined => {
  if (suffix === ".tar.gz" || suffix === ".tgz") return "tar.gz";
  if (suffix === ".zip") return "zip";
  return undefined;
};

const extractMemberFromArchive = (
  archive: Uint8Array,
  kind: "tar.gz" | "zip",
  member: string,
): Uint8Array | undefined =>
  kind === "tar.gz" ? extractTarGzMember(archive, member) : extractZipMember(archive, member);

/**
 * Resolve a (possibly nested, single-boundary) member selector against an
 * outer archive. A selector segment that names a member ending in a supported
 * archive suffix is unwrapped exactly once before resolving the remaining
 * suffix inside it.
 */
const extractSelector = (
  outer: Uint8Array,
  outerKind: "tar.gz" | "zip",
  selector: string,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } => {
  if (selector.length === 0 || selector.includes("\0")) {
    return { ok: false, reason: `Invalid member selector "${selector}".` };
  }
  const boundaryIndex = findNestedBoundary(selector);
  if (boundaryIndex === undefined) {
    const bytes = extractMemberFromArchive(outer, outerKind, selector);
    return bytes === undefined
      ? { ok: false, reason: `Member "${selector}" not found.` }
      : { ok: true, bytes };
  }
  const nestedMemberName = selector.slice(0, boundaryIndex.end);
  const remaining = selector.slice(boundaryIndex.end + 1);
  if (remaining.length === 0 || remaining.includes("/")) {
    return { ok: false, reason: `Nested member selector "${selector}" exceeds one archive boundary.` };
  }
  const nestedArchive = extractMemberFromArchive(outer, outerKind, nestedMemberName);
  if (nestedArchive === undefined) {
    return { ok: false, reason: `Nested archive "${nestedMemberName}" not found.` };
  }
  const nestedKind = archiveKindFor(boundaryIndex.suffix);
  if (nestedKind === undefined) {
    return { ok: false, reason: `Unsupported nested archive type for "${nestedMemberName}".` };
  }
  const bytes = extractMemberFromArchive(nestedArchive, nestedKind, remaining);
  return bytes === undefined
    ? { ok: false, reason: `Member "${remaining}" not found in nested archive "${nestedMemberName}".` }
    : { ok: true, bytes };
};

/** Find the first `/` boundary that immediately follows a supported archive suffix. */
const findNestedBoundary = (selector: string): { end: number; suffix: string } | undefined => {
  let searchFrom = 0;
  while (searchFrom < selector.length) {
    const slash = selector.indexOf("/", searchFrom);
    if (slash === -1) return undefined;
    const segment = selector.slice(0, slash);
    const suffix = NESTED_ARCHIVE_SUFFIXES.find((s) => segment.endsWith(s));
    if (suffix !== undefined) return { end: slash, suffix };
    searchFrom = slash + 1;
  }
  return undefined;
};

const isCurrent = (input: ProvisionToolInput, installPath: string) =>
  Effect.gen(function* () {
    const markerVersion = yield* Effect.promise(() =>
      readInstalledToolVersionMarker(input.binDir, input.toolId),
    );
    if (markerVersion !== input.manifest.toolVersion) return undefined;
    const fingerprint = yield* Effect.promise(async () => {
      try {
        const info = await stat(installPath);
        if (!info.isFile() || info.size === 0) return undefined;
        const [bytes, recorded] = await Promise.all([
          readFile(installPath),
          readFile(fingerprintPath(installPath), "utf-8"),
        ]);
        const actual = sha256Hex(bytes);
        return actual === recorded.trim() ? actual : undefined;
      } catch {
        return undefined;
      }
    });
    return fingerprint;
  });

const installBytes = (
  input: ProvisionToolInput,
  installPath: string,
  bytes: Uint8Array,
  mode: number,
): Effect.Effect<void, ToolExtractError> =>
  Effect.tryPromise({
    try: async () => {
      const dir = dirname(installPath);
      await mkdir(dir, { recursive: true });
      const tmpPath = join(dir, `.${basename(installPath)}.tmp-${process.pid}-${Date.now()}`);
      try {
        await writeFile(tmpPath, bytes, { flag: "wx" });
        if (input.platform !== "win32") await chmod(tmpPath, mode);
        await rename(tmpPath, installPath);
        await writeFile(fingerprintPath(installPath), `${sha256Hex(bytes)}\n`, "utf-8");
      } catch (cause) {
        await rm(tmpPath, { force: true });
        throw cause;
      }
    },
    catch: (cause) =>
      new ToolExtractError({
        message: `Failed to install "${input.key}" at ${installPath}.`,
        toolId: input.toolId,
        ...(input.manifest.artifacts[input.key]?.member === undefined
          ? {}
          : { member: input.manifest.artifacts[input.key]?.member }),
        remediation: "Retry `lando setup`; if it persists report the artifact URL.",
        cause,
      }),
  });

/**
 * Provision a single tool artifact: resolve its entry, fetch+verify the bytes
 * through the `Downloader`, extract the named member, and install it under a
 * realpath-contained `<binDir>` path with the declared mode. Writes a version
 * marker plus a per-binary `.sha256` fingerprint so a matching re-run is an
 * idempotent no-op with no network access.
 */
export const provisionTool = (
  input: ProvisionToolInput,
): Effect.Effect<InstalledTool, ToolError, Downloader | Scope.Scope> =>
  Effect.gen(function* () {
    const entry = input.manifest.artifacts[input.key];
    if (entry === undefined) {
      return yield* Effect.fail(
        new ToolManifestError({
          message: `No artifact entry for key "${input.key}" in the ${input.toolId} manifest.`,
          toolId: input.toolId,
          key: input.key,
          remediation: "Run `lando setup` on a supported host or update the bundled manifest.",
        }),
      );
    }

    const contained = resolveContainedInstallPath(input.binDir, input.toolId, entry.installName);
    if (!contained.ok) return yield* Effect.fail(contained.error);
    const installPath = contained.path;
    yield* ensureRealpathContainedInstallParent(input, installPath);

    const mode = entry.mode !== undefined ? Number.parseInt(entry.mode, 8) || DEFAULT_MODE : DEFAULT_MODE;

    if (input.force !== true) {
      const currentSha = yield* isCurrent(input, installPath);
      if (currentSha !== undefined) {
        return {
          key: input.key,
          installPath,
          toolVersion: input.manifest.toolVersion,
          sha256: currentSha,
          fromCache: false,
          skipped: true,
        } satisfies InstalledTool;
      }
    }

    const downloader = yield* Downloader;
    const filename =
      basename(new URL(entry.url).pathname) || `${input.toolId}-${input.key.replace(/\W+/gu, "-")}`;
    const result = yield* downloader.download({
      url: entry.url,
      destination: { kind: "file", directory: input.toolDownloadsDir, filename },
      expectedSha256: entry.sha256,
      ...(entry.sizeBytes === undefined ? {} : { expectedSizeBytes: entry.sizeBytes }),
      callerId: input.toolId,
      ...(input.offline === undefined ? {} : { offline: input.offline }),
    });

    const archiveBytes = yield* Effect.tryPromise({
      try: () => readFile(result.path ?? join(input.toolDownloadsDir, filename)),
      catch: (cause) =>
        new ToolExtractError({
          message: `Failed to read the verified archive for "${input.key}".`,
          toolId: input.toolId,
          remediation: "Retry `lando setup`.",
          cause,
        }),
    }).pipe(Effect.map((buf) => new Uint8Array(buf)));

    let binaryBytes: Uint8Array;
    if (entry.archive === undefined) {
      binaryBytes = archiveBytes;
    } else {
      const member = entry.member;
      if (member === undefined) {
        return yield* Effect.fail(
          new ToolExtractError({
            message: `Entry "${input.key}" sets archive "${entry.archive}" but no member.`,
            toolId: input.toolId,
            remediation: "Set the archive member in the manifest.",
          }),
        );
      }
      const extracted = extractSelector(archiveBytes, entry.archive, member);
      if (!extracted.ok) {
        return yield* Effect.fail(
          new ToolExtractError({
            message: extracted.reason,
            toolId: input.toolId,
            member,
            remediation: "Verify the pinned manifest member path against the upstream archive layout.",
          }),
        );
      }
      binaryBytes = extracted.bytes;
    }

    yield* installBytes(input, installPath, binaryBytes, mode);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(input.binDir, { recursive: true });
        await writeFile(
          versionMarkerPath(input.binDir, input.toolId),
          `${input.manifest.toolVersion}\n`,
          "utf-8",
        );
      },
      catch: (cause) =>
        new ToolExtractError({
          message: `Failed to record the installed ${input.toolId} version.`,
          toolId: input.toolId,
          remediation: "Retry `lando setup`.",
          cause,
        }),
    });

    return {
      key: input.key,
      installPath,
      toolVersion: input.manifest.toolVersion,
      sha256: sha256Hex(binaryBytes),
      fromCache: result.fromCache,
      skipped: false,
    } satisfies InstalledTool;
  });
