/**
 * Mutagen binary downloader — downloads the host CLI and per-platform agent
 * binaries to `<userDataRoot>/bin/` against the pinned `mutagen-versions.json`
 * manifest (SHA-256 verified). Re-runs are idempotent: already-installed
 * binaries at the current pinned version are reused without re-downloading.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/core/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { HostPlatform, NetworkConfig } from "@lando/sdk/schema";

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

// These builders construct real host filesystem paths and must stay bound to
// the host separator even when a test fakes `process.platform`. `node:path.sep`
// is fixed at load to the real host, so it selects the column independently of
// the (possibly faked) `process.platform`, matching the old `node:path.join`.
const hostBinDir = (userDataRoot: string): string =>
  makeLandoPaths({ userDataRoot, platform: sep === "\\" ? "win32" : "linux" }).binDir;

/** Absolute path where the Mutagen host CLI is installed. */
export const mutagenHostBinaryPath = (userDataRoot: string, platform?: HostPlatform): string => {
  const p = platform ?? currentHostPlatform();
  const installName = p === "win32" ? "mutagen.exe" : "mutagen";
  return safeBinPath(hostBinDir(userDataRoot), installName);
};

/** Absolute path where a Mutagen agent binary is installed. */
export const mutagenAgentBinaryPath = (userDataRoot: string, agentKey: string): string => {
  if (!/^[a-z0-9-]+$/u.test(agentKey)) {
    throw new Error(`Invalid Mutagen agent key "${agentKey}".`);
  }
  return safeBinPath(join(hostBinDir(userDataRoot), "mutagen-agents"), `mutagen-agent-${agentKey}`);
};

/** Path to the file that records the currently installed Mutagen version. */
export const mutagenInstalledVersionPath = (userDataRoot: string): string =>
  join(hostBinDir(userDataRoot), ".mutagen-installed-version");

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
 * Uses the central directory to recover sizes for entries that set the
 * data-descriptor flag (bit 3), which leaves the local header sizes at 0.
 */
interface ZipCentralDirectoryEntry {
  readonly flags: number;
  readonly compression: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const readZipCentralDirectory = (archiveBytes: Uint8Array): Map<number, ZipCentralDirectoryEntry> => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  for (let pos = archiveBytes.length - 22; pos >= 0; pos--) {
    if (view.getUint32(pos, true) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const centralDirectoryOffset = view.getUint32(pos + 16, true);
    const centralDirectorySize = view.getUint32(pos + 12, true);
    const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
    const entries = new Map<number, ZipCentralDirectoryEntry>();
    let cdPos = centralDirectoryOffset;
    while (cdPos + 46 <= centralDirectoryEnd) {
      if (view.getUint32(cdPos, true) !== ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE) break;
      const flags = view.getUint16(cdPos + 8, true);
      const compression = view.getUint16(cdPos + 10, true);
      const compressedSize = view.getUint32(cdPos + 20, true);
      const uncompressedSize = view.getUint32(cdPos + 24, true);
      const filenameLen = view.getUint16(cdPos + 28, true);
      const extraLen = view.getUint16(cdPos + 30, true);
      const commentLen = view.getUint16(cdPos + 32, true);
      const localHeaderOffset = view.getUint32(cdPos + 42, true);
      entries.set(localHeaderOffset, { flags, compression, compressedSize, uncompressedSize });
      cdPos += 46 + filenameLen + extraLen + commentLen;
    }
    return entries;
  }
  return new Map();
};

const zipDataDescriptorLength = (archiveBytes: Uint8Array, descriptorOffset: number): number => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  if (descriptorOffset + 4 > archiveBytes.length) return 12;
  return view.getUint32(descriptorOffset, true) === ZIP_DATA_DESCRIPTOR_SIGNATURE ? 16 : 12;
};

const extractBinaryFromZip = (archiveBytes: Uint8Array, binaryName: string): Uint8Array => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const centralDirectory = readZipCentralDirectory(archiveBytes);
  let pos = 0;
  while (pos + 30 <= archiveBytes.length) {
    const sig = view.getUint32(pos, true);
    if (sig !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) break; // end of local file entries
    const headerFlags = view.getUint16(pos + 6, true);
    const headerCompression = view.getUint16(pos + 8, true);
    const headerCompressedSize = view.getUint32(pos + 18, true);
    const headerUncompressedSize = view.getUint32(pos + 22, true);
    const filenameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const filenameBuf = archiveBytes.subarray(pos + 30, pos + 30 + filenameLen);
    const filename = new TextDecoder("utf-8").decode(filenameBuf);
    const dataOffset = pos + 30 + filenameLen + extraLen;
    const indexed = centralDirectory.get(pos);
    const flags = indexed?.flags ?? headerFlags;
    const compression = indexed?.compression ?? headerCompression;
    const compressedSize = indexed?.compressedSize ?? headerCompressedSize;
    const uncompressedSize = indexed?.uncompressedSize ?? headerUncompressedSize;
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
    const descriptorLength =
      (flags & 0x08) !== 0 ? zipDataDescriptorLength(archiveBytes, dataOffset + compressedSize) : 0;
    pos = dataOffset + compressedSize + descriptorLength;
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
  readonly archiveBytes: Uint8Array;
  readonly entry: MutagenBinaryEntry;
  readonly installPath: string;
  readonly extractImpl: ExtractImpl;
}

interface LoadedNetworkConfig extends NetworkConfig {
  readonly ca?:
    | (NonNullable<NetworkConfig["ca"]> & {
        readonly loadedCerts?: ReadonlyArray<{ readonly pem: string }>;
      })
    | undefined;
}

const fetchInitForNetwork = (
  url: string,
  network: NetworkConfig | undefined,
): BunFetchRequestInit | undefined => {
  const parsedUrl = new URL(url);
  const loaded = network as LoadedNetworkConfig | undefined;
  const host = parsedUrl.hostname.toLowerCase();
  const port = parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80");
  const hostWithPort = `${host}:${port}`;
  const bypassProxy =
    loaded?.proxy?.noProxy.some((raw) => {
      const pattern = raw.toLowerCase();
      if (pattern === "*") return true;
      if (pattern === host || pattern === hostWithPort) return true;
      if (pattern.startsWith(".")) return host.endsWith(pattern);
      return host.endsWith(`.${pattern}`);
    }) ?? false;
  const proxyCandidate = bypassProxy
    ? undefined
    : parsedUrl.protocol === "https:"
      ? (loaded?.proxy?.https ?? loaded?.proxy?.http)
      : (loaded?.proxy?.http ?? loaded?.proxy?.https);
  const proxy = typeof proxyCandidate === "string" && proxyCandidate.length > 0 ? proxyCandidate : undefined;
  const ca = loaded?.ca?.loadedCerts?.map((cert) => cert.pem);
  if (proxy === undefined && (ca === undefined || ca.length === 0)) return undefined;
  return {
    ...(proxy === undefined ? {} : { proxy }),
    ...(ca === undefined || ca.length === 0 ? {} : { tls: { ca } }),
  };
};

const downloadVerifiedArchive = (
  entry: MutagenBinaryEntry,
  fetchImpl: typeof fetch,
  network: NetworkConfig | undefined,
): Effect.Effect<Uint8Array, FileSyncStartError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(entry.url, fetchInitForNetwork(entry.url, network));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${entry.url}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actual = sha256Hex(bytes);
      if (actual !== entry.sha256) {
        throw new MutagenBinaryChecksumError(
          `Mutagen archive checksum mismatch for ${entry.archiveFilename}: expected ${entry.sha256}, got ${actual}.`,
          { url: entry.url, expected: entry.sha256, actual },
        );
      }
      return bytes;
    },
    catch: (cause) =>
      cause instanceof MutagenBinaryChecksumError
        ? cause
        : new MutagenBinaryDownloadError(`Failed to download Mutagen binary from ${entry.url}.`, cause),
  });

const installBinaryFromArchive = (options: InstallBinaryOptions): Effect.Effect<void, FileSyncStartError> =>
  Effect.gen(function* () {
    const { archiveBytes, entry, installPath, extractImpl } = options;

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
          await writeInstalledBinaryFingerprint(installPath, binaryBytes);
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
  readonly network?: NetworkConfig;
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

const mutagenBinarySha256Path = (path: string): string => `${path}.sha256`;

const writeInstalledBinaryFingerprint = async (path: string, bytes: Uint8Array): Promise<void> => {
  await writeFile(mutagenBinarySha256Path(path), `${sha256Hex(bytes)}\n`, "utf-8");
};

const fileMatchesRecordedFingerprint = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return false;
    const [binaryBytes, recorded] = await Promise.all([
      readFile(path),
      readFile(mutagenBinarySha256Path(path), "utf-8"),
    ]);
    return sha256Hex(binaryBytes) === recorded.trim();
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

  const valid = await Promise.all(paths.map(fileMatchesRecordedFingerprint));
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

      // Linux/macOS host archives include the agent payload, so one verified
      // host download can supply both the CLI and the agents. Windows host zips
      // do not, so fetch each pinned agent archive separately there.
      const hostArchiveBytes = yield* downloadVerifiedArchive(hostEntry, fetchImpl, options.network);

      yield* installBinaryFromArchive({
        archiveBytes: hostArchiveBytes,
        entry: hostEntry,
        installPath: mutagenHostBinaryPath(userDataRoot, platform),
        extractImpl,
      });

      for (const [agentKey, agentEntry] of Object.entries(manifest.agents)) {
        const agentArchiveBytes =
          platform === "win32"
            ? yield* downloadVerifiedArchive(agentEntry, fetchImpl, options.network)
            : hostArchiveBytes;
        yield* installBinaryFromArchive({
          archiveBytes: agentArchiveBytes,
          entry: agentEntry,
          installPath: mutagenAgentBinaryPath(userDataRoot, agentKey),
          extractImpl,
        });
      }

      yield* writeInstalledVersion(userDataRoot, manifest.mutagenVersion);
    }),
});
