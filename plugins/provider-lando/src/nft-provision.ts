import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { Effect, Schema } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import manifestData from "../nft-versions.json" with { type: "json" };
import type { ArtifactDownload } from "./runtime-bundle.ts";

const PROVIDER_ID = "lando";
const NFT_LIB_DIRNAME = "nft";
const VERSION_MARKER = ".nft.version";
const WRAPPER_MODE = 0o755;
const BINARY_MODE = 0o755;

const NftPackageSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  url: Schema.String.pipe(Schema.pattern(/^https:\/\//u)),
  sha256: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  filename: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)),
  sizeBytes: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const NftManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  toolVersion: Schema.String.pipe(Schema.minLength(1)),
  packages: Schema.Record({
    key: Schema.String,
    value: Schema.Array(NftPackageSchema).pipe(Schema.minItems(1)),
  }),
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

export interface ArMember {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export const parseArMembers = (archive: Uint8Array): ReadonlyArray<ArMember> => {
  const header = Buffer.from(archive.subarray(0, 8)).toString("ascii");
  if (header !== "!<arch>\n") {
    throw new Error("Not a Debian ar archive.");
  }
  const members: ArMember[] = [];
  let pos = 8;
  while (pos + 60 <= archive.length) {
    const name = Buffer.from(archive.subarray(pos, pos + 16))
      .toString("ascii")
      .trim()
      .replace(/\/$/u, "");
    const sizeText = Buffer.from(archive.subarray(pos + 48, pos + 58))
      .toString("ascii")
      .trim();
    const size = Number.parseInt(sizeText, 10);
    if (!Number.isFinite(size) || size < 0) break;
    pos += 60;
    members.push({ name, bytes: archive.subarray(pos, pos + size) });
    pos += size;
    if (size % 2 === 1) pos += 1;
  }
  return members;
};

export interface TarEntry {
  readonly name: string;
  readonly kind: "file" | "symlink";
  readonly bytes?: Uint8Array;
  readonly linkname?: string;
}

export const parseTarEntries = (tar: Uint8Array): ReadonlyArray<TarEntry> => {
  const BLOCK = 512;
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header[0] === 0) break;
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd += 1;
    let name = Buffer.from(header.subarray(0, nameEnd)).toString("utf8");
    const prefixEnd = 345 + 155;
    if (header[257] === 117 && header[345] !== 0) {
      let prefixLen = 0;
      while (345 + prefixLen < prefixEnd && header[345 + prefixLen] !== 0) prefixLen += 1;
      if (prefixLen > 0) {
        name = `${Buffer.from(header.subarray(345, 345 + prefixLen)).toString("utf8")}/${name}`;
      }
    }
    const sizeOctal = Buffer.from(header.subarray(124, 136))
      .toString("ascii")
      .replace(/[^0-7]/gu, "");
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    const typeflag = header[156] === undefined ? 0 : header[156];
    pos += BLOCK;
    if (typeflag === 48 || typeflag === 0) {
      entries.push({ name, kind: "file", bytes: tar.subarray(pos, pos + size) });
    } else if (typeflag === 50) {
      let linkEnd = 157;
      while (linkEnd < 257 && header[linkEnd] !== 0) linkEnd += 1;
      entries.push({
        name,
        kind: "symlink",
        linkname: Buffer.from(header.subarray(157, linkEnd)).toString("utf8"),
      });
    }
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
};

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

export const decompressXz = async (bytes: Uint8Array): Promise<Uint8Array> => {
  try {
    const python = await runProcess(
      "python3",
      ["-c", "import lzma,sys; sys.stdout.buffer.write(lzma.decompress(sys.stdin.buffer.read()))"],
      bytes,
    );
    if (python.exitCode === 0 && python.stdout.length > 0) return python.stdout;
  } catch {
    // Fall through to xz(1).
  }
  const xz = await runProcess("xz", ["-dc"], bytes);
  if (xz.exitCode !== 0) {
    throw new Error(xz.stderr.trim() || "Failed to decompress xz payload.");
  }
  return xz.stdout;
};

export const decompressDebDataTar = async (memberName: string, bytes: Uint8Array): Promise<Uint8Array> => {
  if (memberName.endsWith(".tar.gz") || memberName.endsWith(".tgz")) {
    return new Uint8Array(gunzipSync(Buffer.from(bytes)));
  }
  if (memberName.endsWith(".tar.zst") || memberName.endsWith(".tar.zstd")) {
    return new Uint8Array(zstdDecompressSync(Buffer.from(bytes)));
  }
  if (memberName.endsWith(".tar.xz")) {
    return decompressXz(bytes);
  }
  if (memberName.endsWith(".tar")) return bytes;
  throw new Error(`Unsupported deb data archive "${memberName}".`);
};

const wantedDebPath = (name: string): "nft" | "lib" | undefined => {
  const normalized = name.replace(/^\.\//u, "");
  if (normalized === "usr/sbin/nft" || normalized.endsWith("/sbin/nft")) return "nft";
  const base = basename(normalized);
  if (
    base.startsWith("libnftables.so") ||
    base.startsWith("libnftnl.so") ||
    base.startsWith("libmnl.so") ||
    base.startsWith("libgmp.so") ||
    base.startsWith("libjansson.so") ||
    base.startsWith("libxtables.so") ||
    base.startsWith("libedit.so")
  ) {
    return "lib";
  }
  return undefined;
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

const collectNftFromExtractedTree = async (
  root: string,
): Promise<{
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}> => {
  const entries: TarEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const name = relative(root, full).replaceAll("\\", "/");
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (ent.isSymbolicLink()) {
        entries.push({ name, kind: "symlink", linkname: await readlink(full) });
        continue;
      }
      if (ent.isFile()) {
        entries.push({ name, kind: "file", bytes: new Uint8Array(await readFile(full)) });
      }
    }
  };
  await walk(root);
  return collectNftDebPayload(entries);
};

const extractNftFromDebWithDpkg = async (
  deb: Uint8Array,
): Promise<{
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}> => {
  const tmp = await mkdtemp(join(tmpdir(), "lando-nft-deb-"));
  try {
    const debPath = join(tmp, "pkg.deb");
    const dest = join(tmp, "out");
    await writeFile(debPath, deb);
    await mkdir(dest, { recursive: true });
    const result = await runProcess("dpkg-deb", ["-x", debPath, dest]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "dpkg-deb failed to extract the nft helper package.");
    }
    return await collectNftFromExtractedTree(dest);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

const extractNftFromDebArchive = async (
  deb: Uint8Array,
): Promise<{
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}> => {
  const members = parseArMembers(deb);
  const data = members.find((member) => member.name.startsWith("data.tar"));
  if (data === undefined) {
    throw new Error("Debian package is missing a data.tar.* member.");
  }
  const tar = await decompressDebDataTar(data.name, data.bytes);
  return collectNftDebPayload(parseTarEntries(tar));
};

export const extractNftFromDeb = async (
  deb: Uint8Array,
): Promise<{
  readonly nft?: Uint8Array;
  readonly libs: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>;
}> => {
  try {
    return await extractNftFromDebWithDpkg(deb);
  } catch {
    return extractNftFromDebArchive(deb);
  }
};

const nftLooksUsable = async (nftPath: string): Promise<boolean> => {
  try {
    const info = await stat(nftPath);
    if (!info.isFile() || (info.mode & 0o111) === 0) return false;
  } catch {
    return false;
  }
  try {
    const result = await runProcess(nftPath, ["--version"]);
    return result.exitCode === 0 && result.stdout.length + result.stderr.length > 0;
  } catch {
    return false;
  }
};

export const hasUsableManagedNft = async (runtimeBinDir: string): Promise<boolean> => {
  const nftPath = managedNftBinPath(runtimeBinDir);
  if (!(await nftLooksUsable(nftPath))) return false;
  try {
    const marker = (await readFile(managedNftVersionPath(runtimeBinDir), "utf8")).trim();
    return marker === NFT_TOOL_VERSION;
  } catch {
    // A future runtime bundle may ship nft without our marker.
    return true;
  }
};

const writeAtomic = async (path: string, bytes: Uint8Array, mode: number): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  await writeFile(tmpPath, bytes, { flag: "w" });
  await chmod(tmpPath, mode);
  await rename(tmpPath, path);
};

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

export const ensureManagedNft = (
  options: EnsureManagedNftOptions,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
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
        try: () => extractNftFromDeb(artifact.bytes),
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

    if (!(yield* Effect.promise(() => nftLooksUsable(managedNftBinPath(options.runtimeBinDir))))) {
      return yield* Effect.fail(
        provisionError("Installed nft helper is not executable or failed `nft --version`."),
      );
    }
  }).pipe(
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
