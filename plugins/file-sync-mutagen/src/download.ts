/**
 * Mutagen binary downloader — downloads the host CLI and per-platform agent
 * binaries to `<userDataRoot>/bin/` against the pinned `mutagen-versions.json`
 * manifest (SHA-256 verified). Re-runs are idempotent: already-installed
 * binaries at the current pinned version are reused without re-downloading.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { Effect, Schema } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";

import manifestData from "../mutagen-versions.json" with { type: "json" };

const ENGINE_ID = "mutagen" as const;

export class MutagenBinaryChecksumError extends FileSyncStartError {
  constructor(message: string, cause?: unknown) {
    super({
      engineId: ENGINE_ID,
      message,
      remediation:
        "The downloaded Mutagen archive checksum did not match the pinned value. Retry `lando setup`; if it fails again, report the release artifact URL and the observed checksum.",
      cause,
    });
  }
}

export class MutagenBinaryDownloadError extends FileSyncStartError {
  constructor(message: string, cause?: unknown) {
    super({
      engineId: ENGINE_ID,
      message,
      remediation:
        "Check network connectivity, proxy/CA configuration, and retry `lando setup` (see docs/guides/setup/file-sync-mutagen.mdx).",
      cause,
    });
  }
}

export class MutagenBinaryUnsupportedPlatformError extends FileSyncStartError {
  constructor(message: string, cause?: unknown) {
    super({
      engineId: ENGINE_ID,
      message,
      remediation:
        "Run `lando setup` on a supported host (Linux x64/arm64, macOS x64/arm64, Windows x64) or update the bundled manifest.",
      cause,
    });
  }
}

const MutagenBinaryEntrySchema = Schema.Struct({
  url: Schema.String.pipe(Schema.pattern(/^https:\/\//u)),
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  archiveFilename: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  binaryName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  installName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
});

const MutagenVersionsManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  mutagenVersion: Schema.String.pipe(Schema.minLength(1)),
  host: Schema.Record({ key: Schema.String, value: MutagenBinaryEntrySchema }),
  agents: Schema.Record({ key: Schema.String, value: MutagenBinaryEntrySchema }),
});

export type MutagenBinaryEntry = Schema.Schema.Type<typeof MutagenBinaryEntrySchema>;
export type MutagenVersionsManifest = Schema.Schema.Type<typeof MutagenVersionsManifestSchema>;

export const MUTAGEN_VERSIONS_MANIFEST: MutagenVersionsManifest = Schema.decodeUnknownSync(
  MutagenVersionsManifestSchema,
)(manifestData);

const safeBinPath = (dir: string, installName: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(installName)) {
    throw new Error(`Invalid Mutagen binary install name "${installName}".`);
  }
  const resolved = resolve(dir, installName);
  const rel = relative(dir, resolved);
  if (rel === "" || rel.startsWith("..") || rel.includes("/../")) {
    throw new Error(`Mutagen binary install name "${installName}" escapes the install directory.`);
  }
  return resolved;
};

/** Absolute path where the Mutagen host CLI is installed. */
export const mutagenHostBinaryPath = (userDataRoot: string, platform?: HostPlatform): string => {
  const p = platform ?? currentHostPlatform();
  const installName = p === "win32" ? "mutagen.exe" : "mutagen";
  return safeBinPath(join(userDataRoot, "bin"), installName);
};

/** Absolute path where a Mutagen agent binary is installed. */
export const mutagenAgentBinaryPath = (userDataRoot: string, agentKey: string): string => {
  if (!/^[a-z0-9-]+$/u.test(agentKey)) {
    throw new Error(`Invalid Mutagen agent key "${agentKey}".`);
  }
  return safeBinPath(join(userDataRoot, "bin", "mutagen-agents"), `mutagen-agent-${agentKey}`);
};

/** Path to the file that records the currently installed Mutagen version. */
export const mutagenInstalledVersionPath = (userDataRoot: string): string =>
  join(userDataRoot, "bin", ".mutagen-installed-version");

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const currentHostPlatform = (): HostPlatform => {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  throw new Error(`Unsupported host platform: ${process.platform}`);
};

/** Map host platform + arch to the manifest host key (e.g. "linux-x64"). */
export const hostPlatformKey = (platform: HostPlatform, arch: string): string => {
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin-arm64";
    if (arch === "x64") return "darwin-x64";
  }
  if (platform === "linux") {
    if (arch === "arm64") return "linux-arm64";
    if (arch === "x64") return "linux-x64";
  }
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new MutagenBinaryUnsupportedPlatformError(
    `No pinned Mutagen host binary entry for platform "${platform}-${arch}".`,
  );
};

/**
 * Extract a named binary from a gzip-compressed tar archive.
 *
 * Implements a minimal streaming-free reader: the whole (decompressed) tar is
 * buffered in memory — fine for the ~10–20 MB Mutagen archives.
 */
const extractBinaryFromTarGz = (archiveBytes: Uint8Array, binaryName: string): Uint8Array => {
  const tar = gunzipSync(Buffer.from(archiveBytes));
  const BLOCK = 512;
  let pos = 0;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header[0] === 0) break; // end-of-archive sentinel
    // Name: first 100 bytes, null-terminated
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const entryName = Buffer.from(header.subarray(0, nameEnd)).toString("latin1");
    // Size: offset 124, 12 octal bytes (may contain spaces and nulls)
    const sizeOctal = Buffer.from(header.subarray(124, 136))
      .toString("ascii")
      .replace(/[^0-7]/gu, "");
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    pos += BLOCK;
    if (basename(entryName) === binaryName) {
      return new Uint8Array(tar.buffer, tar.byteOffset + pos, size);
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error(`Binary "${binaryName}" not found in tar.gz archive.`);
};

/**
 * Extract a named binary from a ZIP archive.
 *
 * Scans local file headers from the beginning of the ZIP stream
 * (no central directory walk needed for flat archives).
 */
const extractBinaryFromZip = (archiveBytes: Uint8Array, binaryName: string): Uint8Array => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  let pos = 0;
  while (pos + 30 <= archiveBytes.length) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break; // end of local file entries
    const flags = view.getUint16(pos + 6, true);
    const compression = view.getUint16(pos + 8, true);
    const compressedSize = view.getUint32(pos + 18, true);
    const uncompressedSize = view.getUint32(pos + 22, true);
    const filenameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const filenameBuf = archiveBytes.subarray(pos + 30, pos + 30 + filenameLen);
    const filename = new TextDecoder("utf-8").decode(filenameBuf);
    const dataOffset = pos + 30 + filenameLen + extraLen;
    if (basename(filename) === binaryName) {
      if (compression === 0) {
        // stored (no compression)
        return archiveBytes.subarray(dataOffset, dataOffset + uncompressedSize);
      }
      if (compression === 8) {
        // deflate
        const compressed = archiveBytes.subarray(dataOffset, dataOffset + compressedSize);
        const inflated = inflateRawSync(Buffer.from(compressed));
        return new Uint8Array(inflated);
      }
      throw new Error(`Unsupported ZIP compression method ${compression} for "${filename}".`);
    }
    pos = dataOffset + compressedSize;
    if ((flags & 0x08) !== 0) pos += 16;
  }
  throw new Error(`Binary "${binaryName}" not found in ZIP archive.`);
};

/**
 * Default archive extractor. Dispatches to tar.gz or zip based on the
 * archive filename extension. Tests inject a fake to avoid real archive
 * bytes.
 */
export type ExtractImpl = (archiveBytes: Uint8Array, entry: MutagenBinaryEntry) => Promise<Uint8Array>;

export const defaultExtract: ExtractImpl = async (archiveBytes, entry) => {
  if (entry.archiveFilename.endsWith(".tar.gz")) {
    if (entry.binaryName.startsWith("linux_")) {
      const agentsArchive = extractBinaryFromTarGz(archiveBytes, "mutagen-agents.tar.gz");
      return extractBinaryFromTarGz(agentsArchive, entry.binaryName);
    }
    return extractBinaryFromTarGz(archiveBytes, entry.binaryName);
  }
  if (entry.archiveFilename.endsWith(".zip")) {
    return extractBinaryFromZip(archiveBytes, entry.binaryName);
  }
  throw new Error(`Unsupported archive format for "${entry.archiveFilename}". Expected .tar.gz or .zip.`);
};

interface InstallBinaryOptions {
  readonly entry: MutagenBinaryEntry;
  readonly installPath: string;
  readonly fetchImpl: typeof fetch;
  readonly extractImpl: ExtractImpl;
}

const installBinary = (options: InstallBinaryOptions): Effect.Effect<void, FileSyncStartError> =>
  Effect.gen(function* () {
    const { entry, installPath, fetchImpl, extractImpl } = options;

    const archiveBytes = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(entry.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${entry.url}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (cause) =>
        new MutagenBinaryDownloadError(`Failed to download Mutagen binary from ${entry.url}.`, cause),
    });

    const actual = sha256Hex(archiveBytes);
    if (actual !== entry.sha256) {
      yield* Effect.fail(
        new MutagenBinaryChecksumError(
          `Mutagen archive checksum mismatch for ${entry.archiveFilename}: expected ${entry.sha256}, got ${actual}.`,
          { url: entry.url, expected: entry.sha256, actual },
        ),
      );
      return;
    }

    const binaryBytes = yield* Effect.tryPromise({
      try: () => extractImpl(archiveBytes, entry),
      catch: (cause) =>
        new MutagenBinaryDownloadError(
          `Failed to extract "${entry.binaryName}" from ${entry.archiveFilename}.`,
          cause,
        ),
    });

    yield* Effect.tryPromise({
      try: async () => {
        const dir = dirname(installPath);
        await mkdir(dir, { recursive: true });
        const tmpPath = join(dir, `.${basename(installPath)}.tmp-${process.pid}-${Date.now()}`);
        try {
          await writeFile(tmpPath, binaryBytes, { flag: "wx" });
          if (process.platform !== "win32") {
            await chmod(tmpPath, 0o755);
          }
          await rename(tmpPath, installPath);
        } catch (cause) {
          await rm(tmpPath, { force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        new MutagenBinaryDownloadError(`Failed to persist Mutagen binary at ${installPath}.`, cause),
    });
  });

export interface MutagenSetupOptions {
  readonly userDataRoot: string;
  /** Re-download even if the currently installed version matches the manifest. */
  readonly force?: boolean;
  /** Injectable for tests. Defaults to `globalThis.fetch` (Bun built-in). */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to {@link defaultExtract}. */
  readonly extractImpl?: ExtractImpl;
  /** Injectable for tests. Defaults to {@link MUTAGEN_VERSIONS_MANIFEST}. */
  readonly _testManifest?: MutagenVersionsManifest;
}

export interface MutagenDownloader {
  readonly setup: (options: MutagenSetupOptions) => Effect.Effect<void, FileSyncStartError>;
}

/** Read the version string recorded at the install marker path, or undefined if absent/unreadable. */
export const readInstalledMutagenVersion = async (userDataRoot: string): Promise<string | undefined> => {
  try {
    const content = await readFile(mutagenInstalledVersionPath(userDataRoot), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
};

export interface InstalledMutagenStatus {
  readonly installedVersion?: string;
  readonly isCurrent: boolean;
}

const expectedInstallPaths = (
  userDataRoot: string,
  manifest: MutagenVersionsManifest,
  platform: HostPlatform,
  arch: string,
): ReadonlyArray<string> => {
  const hostKey = hostPlatformKey(platform, arch);
  const hostEntry = manifest.host[hostKey];
  if (hostEntry === undefined) return [];
  return [
    mutagenHostBinaryPath(userDataRoot, platform),
    ...Object.keys(manifest.agents).map((agentKey) => mutagenAgentBinaryPath(userDataRoot, agentKey)),
  ];
};

const fileExistsWithBytes = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
};

export const readInstalledMutagenStatus = async (
  userDataRoot: string,
  manifest: MutagenVersionsManifest = MUTAGEN_VERSIONS_MANIFEST,
  platform: HostPlatform = currentHostPlatform(),
  arch: string = process.arch,
): Promise<InstalledMutagenStatus> => {
  const installedVersion = await readInstalledMutagenVersion(userDataRoot);
  if (installedVersion !== manifest.mutagenVersion) {
    return { ...(installedVersion === undefined ? {} : { installedVersion }), isCurrent: false };
  }

  let paths: ReadonlyArray<string>;
  try {
    paths = expectedInstallPaths(userDataRoot, manifest, platform, arch);
  } catch {
    return { installedVersion, isCurrent: false };
  }
  if (paths.length === 0) return { installedVersion, isCurrent: false };

  const valid = await Promise.all(paths.map(fileExistsWithBytes));
  return { installedVersion, isCurrent: valid.every(Boolean) };
};

const writeInstalledVersion = (
  userDataRoot: string,
  version: string,
): Effect.Effect<void, FileSyncStartError> =>
  Effect.tryPromise({
    try: async () => {
      const versionPath = mutagenInstalledVersionPath(userDataRoot);
      await mkdir(dirname(versionPath), { recursive: true });
      await writeFile(versionPath, version, "utf-8");
    },
    catch: (cause) => new MutagenBinaryDownloadError("Failed to record installed Mutagen version.", cause),
  });

/**
 * Construct the default Mutagen downloader. Downloading and installing
 * the host CLI and all agent binaries happens inside `setup()`.
 *
 * The `fetchImpl` and `extractImpl` parameters exist for unit-test
 * injection; production code omits them.
 */
export const makeMutagenDownloader = (): MutagenDownloader => ({
  setup: (options) =>
    Effect.gen(function* () {
      const { userDataRoot, force = false } = options;
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      const extractImpl = options.extractImpl ?? defaultExtract;
      const manifest = options._testManifest ?? MUTAGEN_VERSIONS_MANIFEST;

      const arch = process.arch;
      const platform = currentHostPlatform();
      let hostKey: string;
      try {
        hostKey = hostPlatformKey(platform, arch);
      } catch (cause) {
        yield* Effect.fail(new MutagenBinaryUnsupportedPlatformError(String(cause), cause));
        return;
      }

      if (!force) {
        const status = yield* Effect.promise(() =>
          readInstalledMutagenStatus(userDataRoot, manifest, platform, arch),
        );
        if (status.isCurrent) {
          return;
        }
      }

      const hostEntry = manifest.host[hostKey];
      if (hostEntry === undefined) {
        yield* Effect.fail(
          new MutagenBinaryUnsupportedPlatformError(
            `No pinned Mutagen host binary entry for platform "${hostKey}".`,
          ),
        );
        return;
      }

      yield* installBinary({
        entry: hostEntry,
        installPath: mutagenHostBinaryPath(userDataRoot, platform),
        fetchImpl,
        extractImpl,
      });

      for (const [agentKey, agentEntry] of Object.entries(manifest.agents)) {
        yield* installBinary({
          entry: agentEntry,
          installPath: mutagenAgentBinaryPath(userDataRoot, agentKey),
          fetchImpl,
          extractImpl,
        });
      }

      yield* writeInstalledVersion(userDataRoot, manifest.mutagenVersion);
    }),
});
