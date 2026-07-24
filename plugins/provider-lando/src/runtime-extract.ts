import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";
const OPERATION = "setup";
const REMEDIATION =
  "The Lando runtime bundle appears corrupt or unsafe. Retry `lando setup`; if it fails again, report the runtime bundle artifact.";
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 2 * 1024 ** 3;

/**
 * Env var that raises the runtime-bundle decompression-bomb guard.
 *
 * Parsed as a positive safe integer byte count. Invalid or absent values keep
 * the default 2 GiB cap. Explicit extractor or installer options take
 * precedence over this environment override.
 */
export const RUNTIME_BUNDLE_MAX_DECOMPRESSED_BYTES_ENV = "LANDO_RUNTIME_BUNDLE_MAX_DECOMPRESSED_BYTES";

export interface RuntimeArchiveEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface RuntimeExtractOptions {
  readonly maxDecompressedBytes?: number | undefined;
}

export type ExtractEntries = (
  archiveBytes: Uint8Array,
  options?: RuntimeExtractOptions | undefined,
) => ReadonlyArray<RuntimeArchiveEntry>;

export class ProviderRuntimeExtractError extends ProviderUnavailableError {
  constructor(message: string, cause?: unknown, remediation = REMEDIATION) {
    super({
      providerId: PROVIDER_ID,
      operation: OPERATION,
      message,
      remediation,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export interface InstallRuntimeBundleOptions {
  readonly archiveBytes: Uint8Array;
  readonly version: string;
  readonly runtimeBinDir: string;
  readonly platform: HostPlatform;
  readonly extractImpl?: ExtractEntries;
  readonly maxDecompressedBytes?: number | undefined;
}

export interface InstallRuntimeBundleResult {
  readonly installed: boolean;
  readonly runtimeBinDir: string;
  readonly version: string;
}

const TAR_BLOCK = 512;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MARKER_FILE = ".runtime-installed-version";

const isGzip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const isZip = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const parseMaxDecompressedBytesEnv = (): number | undefined => {
  const raw = process.env[RUNTIME_BUNDLE_MAX_DECOMPRESSED_BYTES_ENV];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return isPositiveSafeInteger(parsed) ? parsed : undefined;
};

const resolveMaxDecompressedBytes = (options?: RuntimeExtractOptions | undefined): number => {
  const explicitMax = options?.maxDecompressedBytes;
  if (explicitMax !== undefined && isPositiveSafeInteger(explicitMax)) {
    return explicitMax;
  }
  return parseMaxDecompressedBytesEnv() ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
};

const decompressedCapRemediation = (): string =>
  `The runtime bundle exceeded the decompressed-size cap. Set ${RUNTIME_BUNDLE_MAX_DECOMPRESSED_BYTES_ENV} to a larger positive byte count only for a trusted runtime bundle, then retry \`lando setup\`.`;

const decompressedCapError = (maxDecompressedBytes: number, cause?: unknown): ProviderRuntimeExtractError =>
  new ProviderRuntimeExtractError(
    `Runtime bundle exceeded the decompressed-size cap of ${maxDecompressedBytes} bytes.`,
    cause,
    decompressedCapRemediation(),
  );

const trimNulls = (value: string): string => value.replace(/\0+$/u, "");

const readNullTerminated = (
  bytes: Uint8Array,
  offset: number,
  length: number,
  encoding: BufferEncoding,
): string => {
  let end = 0;
  while (end < length && bytes[offset + end] !== 0) end += 1;
  return Buffer.from(bytes.subarray(offset, offset + end)).toString(encoding);
};

const readTarOctal = (header: Uint8Array, offset: number, length: number): number => {
  const octal = Buffer.from(header.subarray(offset, offset + length))
    .toString("ascii")
    .replace(/[^0-7]/gu, "");
  return octal.length > 0 ? Number.parseInt(octal, 8) : 0;
};

const normalizeArchivePath = (entryName: string): string => {
  const slashName = entryName.replace(/\\/gu, "/");
  if (slashName.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(entryName)) {
    throw new ProviderRuntimeExtractError(`Runtime bundle entry uses an absolute path: ${entryName}`);
  }
  const segments = slashName.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new ProviderRuntimeExtractError(
      `Runtime bundle entry escapes the extraction directory: ${entryName}`,
    );
  }
  return segments.join("/");
};

const parseTarGzEntries = (
  archiveBytes: Uint8Array,
  maxDecompressedBytes: number,
): ReadonlyArray<RuntimeArchiveEntry> => {
  let tar: Buffer;
  try {
    tar = gunzipSync(Buffer.from(archiveBytes), { maxOutputLength: maxDecompressedBytes });
  } catch (cause) {
    if (hasErrorCode(cause, "ERR_BUFFER_TOO_LARGE")) throw decompressedCapError(maxDecompressedBytes, cause);
    throw cause;
  }
  const entries: RuntimeArchiveEntry[] = [];
  let pos = 0;
  let longName: string | undefined;

  while (pos + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + TAR_BLOCK);
    if (header[0] === 0) break;

    const name = readNullTerminated(header, 0, 100, "latin1");
    const prefix = readNullTerminated(header, 345, 155, "latin1");
    const mode = readTarOctal(header, 100, 8);
    const size = readTarOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    pos += TAR_BLOCK;
    const dataStart = pos;
    pos += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === "L") {
      longName = trimNulls(Buffer.from(tar.subarray(dataStart, dataStart + size)).toString("utf8"));
      continue;
    }

    const fullName = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    longName = undefined;

    if (typeflag === "2" || typeflag === "1" || typeflag === "k" || typeflag === "K" || typeflag === "h") {
      throw new ProviderRuntimeExtractError(`Runtime bundle entry ${fullName} uses a forbidden link type.`);
    }

    const safePath = normalizeArchivePath(fullName);
    if (safePath === "" || typeflag === "5") continue;
    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ path: safePath, bytes: tar.subarray(dataStart, dataStart + size), mode });
    }
  }

  return entries;
};

interface ZipCentralDirectoryEntry {
  readonly flags: number;
  readonly compression: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly mode: number;
}

const readZipCentralDirectory = (archiveBytes: Uint8Array): Map<number, ZipCentralDirectoryEntry> => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  for (let pos = archiveBytes.length - 22; pos >= 0; pos -= 1) {
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
      const externalAttributes = view.getUint32(cdPos + 38, true);
      const localHeaderOffset = view.getUint32(cdPos + 42, true);
      entries.set(localHeaderOffset, {
        flags,
        compression,
        compressedSize,
        uncompressedSize,
        mode: (externalAttributes >>> 16) & 0xffff,
      });
      cdPos += 46 + filenameLen + extraLen + commentLen;
    }
    return entries;
  }
  throw new ProviderRuntimeExtractError("Runtime bundle ZIP archive is missing its central directory.");
};

const zipDataDescriptorLength = (archiveBytes: Uint8Array, descriptorOffset: number): number => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  if (descriptorOffset + 4 > archiveBytes.length) return 12;
  return view.getUint32(descriptorOffset, true) === ZIP_DATA_DESCRIPTOR_SIGNATURE ? 16 : 12;
};

const parseZipEntries = (
  archiveBytes: Uint8Array,
  maxDecompressedBytes: number,
): ReadonlyArray<RuntimeArchiveEntry> => {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  const centralDirectory = readZipCentralDirectory(archiveBytes);
  const decoder = new TextDecoder("utf-8");
  const entries: RuntimeArchiveEntry[] = [];
  let decompressedBytes = 0;
  let pos = 0;

  while (pos + 30 <= archiveBytes.length) {
    const sig = view.getUint32(pos, true);
    if (sig !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) break;

    const headerFlags = view.getUint16(pos + 6, true);
    const headerCompression = view.getUint16(pos + 8, true);
    const headerCompressedSize = view.getUint32(pos + 18, true);
    const headerUncompressedSize = view.getUint32(pos + 22, true);
    const filenameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const filename = decoder.decode(archiveBytes.subarray(pos + 30, pos + 30 + filenameLen));
    const dataOffset = pos + 30 + filenameLen + extraLen;
    const indexed = centralDirectory.get(pos);
    const flags = indexed?.flags ?? headerFlags;
    const compression = indexed?.compression ?? headerCompression;
    const compressedSize = indexed?.compressedSize ?? headerCompressedSize;
    const uncompressedSize = indexed?.uncompressedSize ?? headerUncompressedSize;
    const mode = indexed?.mode ?? 0;

    if ((mode & 0xf000) === 0xa000) {
      throw new ProviderRuntimeExtractError(`Runtime bundle ZIP entry ${filename} is a symlink.`);
    }

    const safePath = normalizeArchivePath(filename);
    if (safePath !== "" && !filename.endsWith("/")) {
      if (compression === 0) {
        decompressedBytes += uncompressedSize;
        if (decompressedBytes > maxDecompressedBytes) throw decompressedCapError(maxDecompressedBytes);
        entries.push({
          path: safePath,
          bytes: archiveBytes.subarray(dataOffset, dataOffset + uncompressedSize),
          mode,
        });
      } else if (compression === 8) {
        if (decompressedBytes >= maxDecompressedBytes) throw decompressedCapError(maxDecompressedBytes);
        const compressed = archiveBytes.subarray(dataOffset, dataOffset + compressedSize);
        let bytes: Buffer;
        try {
          bytes = inflateRawSync(Buffer.from(compressed), {
            maxOutputLength: maxDecompressedBytes - decompressedBytes,
          });
        } catch (cause) {
          if (hasErrorCode(cause, "ERR_BUFFER_TOO_LARGE"))
            throw decompressedCapError(maxDecompressedBytes, cause);
          throw cause;
        }
        decompressedBytes += bytes.byteLength;
        if (decompressedBytes > maxDecompressedBytes) throw decompressedCapError(maxDecompressedBytes);
        entries.push({ path: safePath, bytes, mode });
      } else {
        throw new ProviderRuntimeExtractError(
          `Runtime bundle ZIP entry ${filename} uses unsupported compression method ${compression}.`,
        );
      }
    }

    const descriptorLength =
      (flags & 0x08) !== 0 ? zipDataDescriptorLength(archiveBytes, dataOffset + compressedSize) : 0;
    pos = dataOffset + compressedSize + descriptorLength;
  }

  return entries;
};

export const extractRuntimeArchiveEntries: ExtractEntries = (archiveBytes, options) => {
  const maxDecompressedBytes = resolveMaxDecompressedBytes(options);
  try {
    if (isGzip(archiveBytes)) return parseTarGzEntries(archiveBytes, maxDecompressedBytes);
    if (isZip(archiveBytes)) return parseZipEntries(archiveBytes, maxDecompressedBytes);
    throw new ProviderRuntimeExtractError("Runtime bundle archive has an unrecognized format.");
  } catch (cause) {
    if (cause instanceof ProviderRuntimeExtractError) throw cause;
    throw new ProviderRuntimeExtractError("Failed to extract the runtime bundle archive.", cause);
  }
};

const stringParentDir = (path: string): string => {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash <= 0) return ".";
  return path.slice(0, slash);
};

const stringJoin = (base: string, relativePath: string): string => {
  if (relativePath === "") return base;
  if (base.endsWith("/") || base.endsWith("\\")) return `${base}${relativePath}`;
  return `${base}/${relativePath}`;
};

const markerPath = (runtimeBinDir: string): string => stringJoin(runtimeBinDir, MARKER_FILE);

const readInstalledVersion = (runtimeBinDir: string): Effect.Effect<string | undefined, never> =>
  Effect.promise(() =>
    readFile(markerPath(runtimeBinDir), "utf8").then(
      (content) => content.trim(),
      () => undefined,
    ),
  );

const runtimeEntrypointNames = (platform: HostPlatform): readonly string[] =>
  platform === "win32" ? ["podman.exe", "gvproxy.exe", "win-sshproxy.exe"] : ["podman"];

const hasInstalledRuntimeEntrypoint = (runtimeBinDir: string, platform: HostPlatform): Promise<boolean> =>
  Promise.all(
    runtimeEntrypointNames(platform).map((name) =>
      access(stringJoin(runtimeBinDir, name)).then(
        () => true,
        () => false,
      ),
    ),
  ).then((results) => results.every(Boolean));

const toExtractError = (message: string, cause: unknown): ProviderRuntimeExtractError =>
  cause instanceof ProviderRuntimeExtractError ? cause : new ProviderRuntimeExtractError(message, cause);

const hasErrorCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;

const replaceRuntimeBinDir = async (tempDir: string, runtimeBinDir: string): Promise<void> => {
  const backupDir = `${runtimeBinDir}.previous-${process.pid}-${Date.now()}`;
  let backupCreated = false;

  await rm(backupDir, { recursive: true, force: true });
  try {
    await rename(runtimeBinDir, backupDir);
    backupCreated = true;
  } catch (cause) {
    if (!hasErrorCode(cause, "ENOENT")) throw cause;
  }

  try {
    await rename(tempDir, runtimeBinDir);
  } catch (cause) {
    if (backupCreated) {
      await rm(runtimeBinDir, { recursive: true, force: true });
      await rename(backupDir, runtimeBinDir);
    }
    throw cause;
  }

  if (backupCreated) {
    await rm(backupDir, { recursive: true, force: true });
  }
};

const stripRuntimeBinPrefix = (safePath: string, stripTopLevelBin: boolean): string => {
  if (!stripTopLevelBin) return safePath;
  if (safePath === "bin") return "";
  return safePath.startsWith("bin/") ? safePath.slice("bin/".length) : safePath;
};

export const installRuntimeBundle = (
  options: InstallRuntimeBundleOptions,
): Effect.Effect<InstallRuntimeBundleResult, ProviderRuntimeExtractError> =>
  Effect.gen(function* () {
    const installedVersion = yield* readInstalledVersion(options.runtimeBinDir);
    const entrypointReady =
      installedVersion === options.version
        ? yield* Effect.promise(() => hasInstalledRuntimeEntrypoint(options.runtimeBinDir, options.platform))
        : false;
    if (entrypointReady) {
      return { installed: false, runtimeBinDir: options.runtimeBinDir, version: options.version };
    }

    const tempDir = `${options.runtimeBinDir}.tmp-${process.pid}-${Date.now()}`;
    const extractImpl = options.extractImpl ?? extractRuntimeArchiveEntries;

    yield* Effect.tryPromise({
      try: async () => {
        try {
          const entries = extractImpl(options.archiveBytes, {
            maxDecompressedBytes: options.maxDecompressedBytes,
          });
          const normalizedEntries = entries.map((entry) => ({
            ...entry,
            safePath: normalizeArchivePath(entry.path),
          }));
          const stripTopLevelBin =
            normalizedEntries.length > 0 &&
            normalizedEntries.every((entry) => entry.safePath === "bin" || entry.safePath.startsWith("bin/"));
          let fileCount = 0;
          await rm(tempDir, { recursive: true, force: true });
          await mkdir(tempDir, { recursive: true });
          for (const entry of normalizedEntries) {
            const safePath = stripRuntimeBinPrefix(entry.safePath, stripTopLevelBin);
            if (safePath === "") continue;
            const target = stringJoin(tempDir, safePath);
            await mkdir(stringParentDir(target), { recursive: true });
            await writeFile(target, entry.bytes);
            if (options.platform !== "win32") {
              await chmod(target, 0o755);
            }
            fileCount += 1;
          }
          if (fileCount === 0) {
            throw new ProviderRuntimeExtractError("Runtime bundle archive does not contain any files.");
          }
          if (!(await hasInstalledRuntimeEntrypoint(tempDir, options.platform))) {
            throw new ProviderRuntimeExtractError(
              `Runtime bundle archive is missing required ${options.platform} entrypoints: ${runtimeEntrypointNames(options.platform).join(", ")}.`,
            );
          }
          await writeFile(markerPath(tempDir), options.version);
          await mkdir(stringParentDir(options.runtimeBinDir), { recursive: true });
          await replaceRuntimeBinDir(tempDir, options.runtimeBinDir);
        } catch (cause) {
          await rm(tempDir, { recursive: true, force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        toExtractError(`Failed to install the Lando runtime bundle into ${options.runtimeBinDir}.`, cause),
    });

    return { installed: true, runtimeBinDir: options.runtimeBinDir, version: options.version };
  });
