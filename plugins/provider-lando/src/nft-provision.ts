import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Effect, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";

import manifestData from "../nft-versions.json" with { type: "json" };
import { type TarEntry, parseArMembers, parseTarEntries } from "./debian-archive.ts";
import { type NftDecompressionOptions, decompressDebDataTar } from "./debian-decompress.ts";
import type { ArtifactDownload } from "./runtime-bundle.ts";
export { type ArMember, type TarEntry, parseArMembers, parseTarEntries } from "./debian-archive.ts";
export { type NftDecompressionOptions, decompressDebDataTar, decompressXz } from "./debian-decompress.ts";

const PROVIDER_ID = "lando";
const NFT_LIB_DIRNAME = "nft";
const VERSION_MARKER = ".nft.version";
const WRAPPER_MODE = 0o755;
const BINARY_MODE = 0o755;

const NftPackageSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  url: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//u))),
  sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  filename: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u))),
  sizeBytes: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
const NftManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  toolVersion: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  packages: Schema.Record(
    Schema.String,
    Schema.Array(NftPackageSchema).pipe(Schema.check(Schema.isMinLength(1))),
  ),
});
export type NftPackage = Schema.Schema.Type<typeof NftPackageSchema>;
export type NftManifest = Schema.Schema.Type<typeof NftManifestSchema>;
export const NFT_MANIFEST: NftManifest = Schema.decodeUnknownSync(NftManifestSchema)(manifestData);
export const NFT_TOOL_VERSION = NFT_MANIFEST.toolVersion;

export const managedNftBinPath = (runtimeBinDir: string): string =>
  join(runtimeBinDir.replace(/\/+$/u, ""), "nft");

export const managedNftLibDir = (runtimeBinDir: string): string =>
  join(dirname(runtimeBinDir.replace(/\/+$/u, "")), "lib", NFT_LIB_DIRNAME);

export const managedNftVersionPath = (runtimeBinDir: string): string =>
  join(runtimeBinDir.replace(/\/+$/u, ""), VERSION_MARKER);

const nftRemediation =
  "Run `lando setup` so Lando can provision nft into the managed runtime, then retry. Do not set network_backend=pasta — this Podman only accepts netavark.";

const provisionError = (message: string, cause?: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: PROVIDER_ID,
    operation: "setup",
    message,
    remediation: nftRemediation,
    ...(cause === undefined ? {} : { cause }),
  });

export const resolveNftHostKey = (platform: string, arch: string): string | undefined => {
  if (platform !== "linux" && platform !== "wsl") return undefined;
  if (arch === "x64" || arch === "amd64") return "linux-x64";
  if (arch === "arm64") return "linux-arm64";
  return undefined;
};

export const NFT_WRAPPER_SCRIPT = `#!/bin/sh
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$HERE/../lib/${NFT_LIB_DIRNAME}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$HERE/../lib/${NFT_LIB_DIRNAME}/nft" "$@"
`;

const runProcess = async (
  command: string,
  args: ReadonlyArray<string>,
  stdin?: Uint8Array,
): Promise<{ readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string }> => {
  const proc = Bun.spawn([command, ...args], {
    stdin: stdin === undefined ? "ignore" : stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr };
};

const BUNDLED_LIB_PREFIXES = [
  "libnftables.so",
  "libnftnl.so",
  "libmnl.so",
  "libgmp.so",
  "libjansson.so",
  "libxtables.so",
  "libedit.so",
  "libtinfo.so",
  "libbsd.so",
  "libmd.so",
] as const;

const wantedDebPath = (name: string): "nft" | "lib" | undefined => {
  const normalized = name.replace(/^\.\//u, "");
  if (normalized === "usr/sbin/nft" || normalized.endsWith("/sbin/nft")) return "nft";
  const base = basename(normalized);
  if (BUNDLED_LIB_PREFIXES.some((prefix) => base.startsWith(prefix))) return "lib";
  return undefined;
};

const HOST_SONAME_PREFIXES = [
  "libc.so",
  "libdl.so",
  "libpthread.so",
  "libm.so",
  "librt.so",
  "libgcc_s.so",
  "ld-linux",
  "linux-vdso.so",
] as const;

export const readElfNeeded = (bytes: Uint8Array): ReadonlyArray<string> => {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[5] !== 1
  )
    return [];
  const is64 = bytes[4] === 2;
  if (!is64 && bytes[4] !== 1) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (off: number): number => view.getUint16(off, true);
  const u32 = (off: number): number => view.getUint32(off, true);
  const uN = (off: number): number => (is64 ? u32(off) + u32(off + 4) * 0x1_0000_0000 : u32(off));
  const phoff = is64 ? uN(32) : u32(28);
  const phentsize = is64 ? u16(54) : u16(42);
  const phnum = is64 ? u16(56) : u16(44);
  if (phoff <= 0 || phentsize < (is64 ? 56 : 32) || phnum <= 0) return [];
  const loads: Array<{ readonly vaddr: number; readonly offset: number; readonly filesz: number }> = [];
  let dynOff = -1;
  let dynFilesz = 0;
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + phentsize > bytes.length) return [];
    const type = u32(off);
    const offset = is64 ? uN(off + 8) : u32(off + 4);
    const vaddr = is64 ? uN(off + 16) : u32(off + 8);
    const filesz = is64 ? uN(off + 32) : u32(off + 16);
    if (type === 1) loads.push({ vaddr, offset, filesz });
    if (type === 2) {
      dynOff = offset;
      dynFilesz = filesz;
    }
  }
  if (dynOff < 0 || dynFilesz <= 0) return [];
  const entSize = is64 ? 16 : 8;
  let strtabVaddr = -1;
  const neededStrOffs: number[] = [];
  const dynEnd = Math.min(dynOff + dynFilesz, bytes.length);
  for (let pos = dynOff; pos + entSize <= dynEnd; pos += entSize) {
    const tag = uN(pos);
    const val = is64 ? uN(pos + 8) : u32(pos + 4);
    if (tag === 0) break;
    if (tag === 1) neededStrOffs.push(val);
    if (tag === 5) strtabVaddr = val;
  }
  if (strtabVaddr < 0) return [];
  const seg = loads.find((seg) => strtabVaddr >= seg.vaddr && strtabVaddr < seg.vaddr + seg.filesz);
  if (seg === undefined) return [];
  const strtabOff = seg.offset + strtabVaddr - seg.vaddr;
  const names: string[] = [];
  for (const rel of neededStrOffs) {
    let end = strtabOff + rel;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    const name = new TextDecoder().decode(bytes.subarray(strtabOff + rel, end));
    if (name.length > 0) names.push(name);
  }
  return names;
};

export const bundledLoaderDepsSatisfied = async (libDir: string): Promise<boolean> => {
  try {
    const files = await readdir(libDir);
    for (const file of new Set(["nft", ...files])) {
      const bytes = new Uint8Array(await readFile(join(libDir, file)));
      for (const needed of readElfNeeded(bytes)) {
        if (HOST_SONAME_PREFIXES.some((prefix) => needed.startsWith(prefix))) continue;
        if (!files.some((name) => name === needed || name.startsWith(`${needed}.`))) return false;
      }
    }
    return true;
  } catch (cause) {
    if (cause instanceof Error) return false;
    throw cause;
  }
};

export const collectNftDebPayload = (
  entries: ReadonlyArray<TarEntry>,
): {
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
} => {
  const libs: Array<{ readonly name: string; readonly bytes: Uint8Array }> = [];
  let nft: Uint8Array | undefined;
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.kind === "file" && entry.bytes !== undefined) {
      files.set(basename(entry.name), entry.bytes);
    }
  }
  for (const entry of entries) {
    const kind = wantedDebPath(entry.name);
    if (kind === undefined) continue;
    if (kind === "nft" && entry.kind === "file" && entry.bytes !== undefined) {
      nft = entry.bytes;
      continue;
    }
    if (kind === "lib") {
      const name = basename(entry.name);
      if (entry.kind === "file" && entry.bytes !== undefined) {
        libs.push({ name, bytes: entry.bytes });
      } else if (entry.kind === "symlink" && entry.linkname !== undefined) {
        const targetName = basename(entry.linkname);
        const target = files.get(targetName);
        if (target !== undefined) libs.push({ name, bytes: target });
      }
    }
  }
  return nft === undefined ? { libs } : { nft, libs };
};

export const extractNftFromDeb = async (
  deb: Uint8Array,
  options?: NftDecompressionOptions,
): Promise<{
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}> => {
  const members = parseArMembers(deb);
  const data = members.find((member) => member.name.startsWith("data.tar"));
  if (data === undefined) {
    throw new Error("Debian package is missing a data.tar.* member.");
  }
  const tar = await decompressDebDataTar(data.name, data.bytes, options);
  return collectNftDebPayload(parseTarEntries(tar));
};

const nftLooksUsable = async (runtimeBinDir: string): Promise<boolean> => {
  const nftPath = managedNftBinPath(runtimeBinDir);
  try {
    const info = await stat(nftPath);
    if (!info.isFile() || (info.mode & 0o111) === 0) return false;
  } catch {
    return false;
  }
  if (!(await bundledLoaderDepsSatisfied(managedNftLibDir(runtimeBinDir)))) return false;
  try {
    const result = await runProcess(nftPath, ["--version"]);
    return result.exitCode === 0 && result.stdout.length + result.stderr.length > 0;
  } catch {
    return false;
  }
};

export const hasUsableManagedNft = async (runtimeBinDir: string): Promise<boolean> => {
  if (!(await nftLooksUsable(runtimeBinDir))) return false;
  try {
    const marker = (await readFile(managedNftVersionPath(runtimeBinDir), "utf8")).trim();
    return marker === NFT_TOOL_VERSION;
  } catch {
    // A future runtime bundle may ship nft without our marker.
    return true;
  }
};

const writeAtomic = async (path: string, bytes: Uint8Array, mode: number): Promise<void> =>
  writeFileAtomic(path, bytes, { mode, ownerOnly: "best-effort" });

export const installManagedNftLayout = async (
  runtimeBinDir: string,
  payload: {
    readonly nft: Uint8Array;
    readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
  },
): Promise<void> => {
  const libDir = managedNftLibDir(runtimeBinDir);
  await mkdir(libDir, { recursive: true });
  await mkdir(runtimeBinDir, { recursive: true });
  await writeAtomic(join(libDir, "nft"), payload.nft, BINARY_MODE);
  for (const lib of payload.libs) {
    await writeAtomic(join(libDir, lib.name), lib.bytes, 0o644);
  }
  await writeAtomic(managedNftBinPath(runtimeBinDir), Buffer.from(NFT_WRAPPER_SCRIPT), WRAPPER_MODE);
  await writeFile(managedNftVersionPath(runtimeBinDir), `${NFT_TOOL_VERSION}\n`, "utf8");
};

export interface EnsureManagedNftOptions {
  readonly runtimeBinDir: string;
  readonly download: ArtifactDownload;
  readonly cacheDir: string;
  readonly platform?: string;
  readonly arch?: string;
}

export const ensureManagedNft = Effect.fn("ProviderLando.ensureManagedNft")(
  function* (options: EnsureManagedNftOptions): Effect.fn.Return<void, ProviderUnavailableError> {
    const platform = options.platform ?? "linux";
    const arch = options.arch ?? process.arch;
    const hostKey = resolveNftHostKey(platform, arch);
    if (hostKey === undefined) return;

    if (yield* Effect.promise(() => hasUsableManagedNft(options.runtimeBinDir))) return;

    const packages = NFT_MANIFEST.packages[hostKey];
    if (packages === undefined) {
      return yield* Effect.fail(provisionError(`No pinned nft helper packages for ${hostKey}.`));
    }

    yield* Effect.tryPromise({
      try: () => mkdir(options.cacheDir, { recursive: true }),
      catch: (cause) => provisionError("Failed to create the nft helper cache directory.", cause),
    });

    let nft: Uint8Array | undefined;
    const libs: Array<{ readonly name: string; readonly bytes: Uint8Array }> = [];

    for (const pkg of packages) {
      const artifact = yield* options.download({
        url: pkg.url,
        expectedSha256: pkg.sha256,
        expectedSizeBytes: pkg.sizeBytes,
        directory: options.cacheDir,
        filename: pkg.filename,
        allowFileSource: pkg.url.startsWith("file://"),
      });
      const extracted = yield* Effect.tryPromise({
        try: (signal) => extractNftFromDeb(artifact.bytes, { signal }),
        catch: (cause) => provisionError(`Failed to extract nft helper from ${pkg.filename}.`, cause),
      });
      if (extracted.nft !== undefined) nft = extracted.nft;
      libs.push(...extracted.libs);
    }

    if (nft === undefined) {
      return yield* Effect.fail(provisionError("Pinned nft packages did not contain /usr/sbin/nft."));
    }

    yield* Effect.tryPromise({
      try: () => installManagedNftLayout(options.runtimeBinDir, { nft, libs }),
      catch: (cause) =>
        provisionError("Failed to install the managed nft helper into the runtime bin.", cause),
    });

    if (!(yield* Effect.promise(() => nftLooksUsable(options.runtimeBinDir)))) {
      return yield* Effect.fail(
        provisionError("Installed nft helper is missing bundled loader libraries or failed `nft --version`."),
      );
    }
  },
  Effect.mapError((cause) =>
    cause instanceof ProviderUnavailableError
      ? cause
      : provisionError("Failed to provision nft for netavark.", cause),
  ),
);

export const removeManagedNft = async (runtimeBinDir: string): Promise<void> => {
  await rm(managedNftBinPath(runtimeBinDir), { force: true });
  await rm(managedNftVersionPath(runtimeBinDir), { force: true });
  await rm(managedNftLibDir(runtimeBinDir), { recursive: true, force: true });
};
