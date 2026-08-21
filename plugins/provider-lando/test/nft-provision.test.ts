import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import {
  NFT_MANIFEST,
  NFT_TOOL_VERSION,
  NFT_WRAPPER_SCRIPT,
  bundledLoaderDepsSatisfied,
  collectNftDebPayload,
  ensureManagedNft,
  extractNftFromDeb,
  hasUsableManagedNft,
  installManagedNftLayout,
  managedNftBinPath,
  managedNftLibDir,
  managedNftVersionPath,
  parseArMembers,
  parseTarEntries,
  readElfNeeded,
  resolveNftHostKey,
} from "../src/nft-provision.ts";
import type { ArtifactDownload } from "../src/runtime-bundle.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const pad = (value: string, length: number): string => value.padEnd(length, " ");

const makeAr = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const chunks: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const member of members) {
    const header = Buffer.from(
      `${pad(member.name, 16)}${pad("0", 12)}${pad("0", 6)}${pad("0", 6)}${pad("100644", 8)}${pad(String(member.bytes.length), 10)}\`\n`,
    );
    chunks.push(header, Buffer.from(member.bytes));
    if (member.bytes.length % 2 === 1) chunks.push(Buffer.from("\n"));
  }
  return new Uint8Array(Buffer.concat(chunks));
};

const makeTar = (
  entries: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const BLOCK = 512;
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(BLOCK);
    Buffer.from(entry.name).copy(header, 0);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from(`${entry.bytes.length.toString(8).padStart(11, "0")}\0`).copy(header, 124);
    header[156] = 48; // '0' regular file
    Buffer.from("ustar\0").copy(header, 257);
    let checksum = 0;
    header.fill(0x20, 148, 156);
    for (const byte of header) checksum += byte;
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);
    chunks.push(header, Buffer.from(entry.bytes));
    const padBytes = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (padBytes > 0) chunks.push(Buffer.alloc(padBytes));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return new Uint8Array(Buffer.concat(chunks));
};

const fakeNftScript = "#!/bin/sh\necho 'nftables v1.1.3 (test)'\n";

const makeElf64Needing = (sonames: ReadonlyArray<string>): Uint8Array => {
  const strtab = Buffer.concat([Buffer.from([0]), ...sonames.map((name) => Buffer.from(`${name}\0`))]);
  const neededOffs: number[] = [];
  let cursor = 1;
  for (const name of sonames) {
    neededOffs.push(cursor);
    cursor += name.length + 1;
  }
  const ehdr = 64;
  const phdr = 56;
  const phnum = 2;
  const dynSize = (sonames.length + 2) * 16;
  const dynOff = ehdr + phdr * phnum;
  const strtabOff = dynOff + dynSize;
  const total = strtabOff + strtab.length;
  const buf = Buffer.alloc(total);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 2;
  buf[5] = 1;
  buf[6] = 1;
  buf.writeUInt16LE(3, 16);
  buf.writeUInt16LE(62, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(0n, 24);
  buf.writeBigUInt64LE(BigInt(ehdr), 32);
  buf.writeBigUInt64LE(0n, 40);
  buf.writeUInt32LE(0, 48);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(phnum, 56);
  buf.writeUInt16LE(64, 58);
  buf.writeUInt16LE(0, 60);
  buf.writeUInt16LE(0, 62);
  buf.writeUInt32LE(1, ehdr);
  buf.writeUInt32LE(5, ehdr + 4);
  buf.writeBigUInt64LE(0n, ehdr + 8);
  buf.writeBigUInt64LE(0n, ehdr + 16);
  buf.writeBigUInt64LE(0n, ehdr + 24);
  buf.writeBigUInt64LE(BigInt(total), ehdr + 32);
  buf.writeBigUInt64LE(BigInt(total), ehdr + 40);
  buf.writeBigUInt64LE(8n, ehdr + 48);
  const dynPh = ehdr + phdr;
  buf.writeUInt32LE(2, dynPh);
  buf.writeUInt32LE(4, dynPh + 4);
  buf.writeBigUInt64LE(BigInt(dynOff), dynPh + 8);
  buf.writeBigUInt64LE(BigInt(dynOff), dynPh + 16);
  buf.writeBigUInt64LE(BigInt(dynOff), dynPh + 24);
  buf.writeBigUInt64LE(BigInt(dynSize), dynPh + 32);
  buf.writeBigUInt64LE(BigInt(dynSize), dynPh + 40);
  buf.writeBigUInt64LE(8n, dynPh + 48);
  let d = dynOff;
  for (const off of neededOffs) {
    buf.writeBigUInt64LE(1n, d);
    buf.writeBigUInt64LE(BigInt(off), d + 8);
    d += 16;
  }
  buf.writeBigUInt64LE(5n, d);
  buf.writeBigUInt64LE(BigInt(strtabOff), d + 8);
  d += 16;
  buf.writeBigUInt64LE(0n, d);
  buf.writeBigUInt64LE(0n, d + 8);
  strtab.copy(buf, strtabOff);
  return new Uint8Array(buf);
};

const makeSyntheticNftDeb = (): Uint8Array => {
  const tar = makeTar([
    { name: "usr/sbin/nft", bytes: Buffer.from(fakeNftScript) },
    { name: "usr/lib/x86_64-linux-gnu/libnftables.so.1.1.0", bytes: Buffer.from("libnftables") },
    { name: "usr/lib/x86_64-linux-gnu/libnftnl.so.11.6.0", bytes: Buffer.from("libnftnl") },
  ]);
  const data = gzipSync(tar);
  return makeAr([
    { name: "debian-binary", bytes: Buffer.from("2.0\n") },
    { name: "data.tar.gz", bytes: new Uint8Array(data) },
  ]);
};

describe("resolveNftHostKey", () => {
  test("maps linux/wsl x64 and arm64 only", () => {
    expect(resolveNftHostKey("linux", "x64")).toBe("linux-x64");
    expect(resolveNftHostKey("wsl", "amd64")).toBe("linux-x64");
    expect(resolveNftHostKey("linux", "arm64")).toBe("linux-arm64");
    expect(resolveNftHostKey("darwin", "arm64")).toBeUndefined();
    expect(resolveNftHostKey("win32", "x64")).toBeUndefined();
  });
});

describe("deb extraction", () => {
  test("parses an ar archive and extracts nft plus helper libs from data.tar.gz", async () => {
    const deb = makeSyntheticNftDeb();
    const members = parseArMembers(deb);
    expect(members.map((member) => member.name)).toEqual(["debian-binary", "data.tar.gz"]);
    const extracted = await extractNftFromDeb(deb);
    expect(Buffer.from(extracted.nft ?? []).toString("utf8")).toContain("nftables v1.1.3");
    expect(extracted.libs.map((lib) => lib.name).sort()).toEqual([
      "libnftables.so.1.1.0",
      "libnftnl.so.11.6.0",
    ]);
  });

  test("collectNftDebPayload resolves soname symlinks to regular files", () => {
    const payload = collectNftDebPayload([
      { name: "usr/sbin/nft", kind: "file", bytes: Buffer.from("nft") },
      { name: "usr/lib/x86_64-linux-gnu/libnftables.so.1.1.0", kind: "file", bytes: Buffer.from("so") },
      {
        name: "usr/lib/x86_64-linux-gnu/libnftables.so.1",
        kind: "symlink",
        linkname: "libnftables.so.1.1.0",
      },
    ]);
    expect(Buffer.from(payload.nft ?? []).toString("utf8")).toBe("nft");
    expect(payload.libs).toEqual([
      { name: "libnftables.so.1.1.0", bytes: Buffer.from("so") },
      { name: "libnftables.so.1", bytes: Buffer.from("so") },
    ]);
  });

  test("parseTarEntries reads ustar regular files", () => {
    const tar = makeTar([{ name: "usr/sbin/nft", bytes: Buffer.from("hi") }]);
    const entries = parseTarEntries(tar);
    expect(entries).toEqual([{ name: "usr/sbin/nft", kind: "file", bytes: Buffer.from("hi") }]);
  });

  test("collectNftDebPayload copies libedit runtime deps", () => {
    const payload = collectNftDebPayload([
      { name: "usr/lib/x86_64-linux-gnu/libedit.so.2.0.70", kind: "file", bytes: Buffer.from("edit") },
      { name: "usr/lib/x86_64-linux-gnu/libtinfo.so.6.5", kind: "file", bytes: Buffer.from("tinfo") },
      { name: "usr/lib/x86_64-linux-gnu/libbsd.so.0.12.2", kind: "file", bytes: Buffer.from("bsd") },
      { name: "usr/lib/x86_64-linux-gnu/libmd.so.0.1.0", kind: "file", bytes: Buffer.from("md") },
      {
        name: "usr/lib/x86_64-linux-gnu/libtinfo.so.6",
        kind: "symlink",
        linkname: "libtinfo.so.6.5",
      },
    ]);
    expect(payload.libs.map((lib) => lib.name).sort()).toEqual([
      "libbsd.so.0.12.2",
      "libedit.so.2.0.70",
      "libmd.so.0.1.0",
      "libtinfo.so.6",
      "libtinfo.so.6.5",
    ]);
  });
});

describe("bundled loader deps", () => {
  test("readElfNeeded returns DT_NEEDED sonames", () => {
    const elf = makeElf64Needing(["libtinfo.so.6", "libbsd.so.0", "libc.so.6"]);
    expect(readElfNeeded(elf)).toEqual(["libtinfo.so.6", "libbsd.so.0", "libc.so.6"]);
  });

  test("rejects a bundled libedit whose runtime deps were not copied", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-nft-loader-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    try {
      await installManagedNftLayout(runtimeBinDir, {
        nft: Buffer.from(fakeNftScript),
        libs: [{ name: "libedit.so.2", bytes: makeElf64Needing(["libtinfo.so.6", "libc.so.6"]) }],
      });
      expect(await bundledLoaderDepsSatisfied(managedNftLibDir(runtimeBinDir))).toBe(false);
      expect(await hasUsableManagedNft(runtimeBinDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts bundled libedit when libtinfo, libbsd, and libmd are present", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-nft-loader-ok-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    try {
      await installManagedNftLayout(runtimeBinDir, {
        nft: Buffer.from(fakeNftScript),
        libs: [
          { name: "libedit.so.2", bytes: makeElf64Needing(["libtinfo.so.6", "libbsd.so.0", "libc.so.6"]) },
          { name: "libtinfo.so.6", bytes: makeElf64Needing(["libc.so.6"]) },
          { name: "libbsd.so.0", bytes: makeElf64Needing(["libmd.so.0", "libc.so.6"]) },
          { name: "libmd.so.0", bytes: makeElf64Needing(["libc.so.6"]) },
        ],
      });
      expect(await bundledLoaderDepsSatisfied(managedNftLibDir(runtimeBinDir))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureManagedNft", () => {
  test("installs a PATH-visible nft wrapper from pinned packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-nft-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const cacheDir = join(root, "cache");
    const deb = makeSyntheticNftDeb();
    const digest = sha256(deb);
    const download: ArtifactDownload = (request) =>
      Effect.succeed({
        bytes: deb,
        sha256: request.expectedSha256,
        path: join(request.directory, request.filename),
      });

    try {
      await mkdir(runtimeBinDir, { recursive: true });
      await Effect.runPromise(
        ensureManagedNft({
          runtimeBinDir,
          download,
          cacheDir,
          platform: "linux",
          arch: "x64",
        }),
      );

      const nftPath = managedNftBinPath(runtimeBinDir);
      expect(await readFile(nftPath, "utf8")).toBe(NFT_WRAPPER_SCRIPT);
      expect(await readFile(managedNftVersionPath(runtimeBinDir), "utf8")).toBe(`${NFT_TOOL_VERSION}\n`);
      expect(await readFile(join(managedNftLibDir(runtimeBinDir), "nft"), "utf8")).toContain(
        "nftables v1.1.3",
      );
      await chmod(join(managedNftLibDir(runtimeBinDir), "nft"), 0o755);
      const version = await Bun.$`${nftPath} --version`.text();
      expect(version).toContain("nftables v1.1.3");
      expect(digest).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("is idempotent when a usable managed nft is already installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-nft-skip-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    let downloads = 0;
    const download: ArtifactDownload = () => {
      downloads += 1;
      return Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "setup",
          message: "should not download",
          remediation: "n/a",
        }),
      );
    };

    try {
      await mkdir(runtimeBinDir, { recursive: true });
      await mkdir(managedNftLibDir(runtimeBinDir), { recursive: true });
      await writeFile(join(managedNftLibDir(runtimeBinDir), "nft"), fakeNftScript, { mode: 0o755 });
      await chmod(join(managedNftLibDir(runtimeBinDir), "nft"), 0o755);
      await writeFile(managedNftBinPath(runtimeBinDir), NFT_WRAPPER_SCRIPT, { mode: 0o755 });
      await chmod(managedNftBinPath(runtimeBinDir), 0o755);
      await writeFile(managedNftVersionPath(runtimeBinDir), `${NFT_TOOL_VERSION}\n`);

      expect(await hasUsableManagedNft(runtimeBinDir)).toBe(true);
      await Effect.runPromise(
        ensureManagedNft({
          runtimeBinDir,
          download,
          cacheDir: join(root, "cache"),
          platform: "linux",
          arch: "x64",
        }),
      );
      expect(downloads).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails when bundled libedit is missing runtime libs even if nft --version would pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-nft-incomplete-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const cacheDir = join(root, "cache");
    const tar = makeTar([
      { name: "usr/sbin/nft", bytes: Buffer.from(fakeNftScript) },
      {
        name: "usr/lib/x86_64-linux-gnu/libedit.so.2",
        bytes: makeElf64Needing(["libtinfo.so.6", "libbsd.so.0", "libc.so.6"]),
      },
    ]);
    const deb = makeAr([
      { name: "debian-binary", bytes: Buffer.from("2.0\n") },
      { name: "data.tar.gz", bytes: new Uint8Array(gzipSync(tar)) },
    ]);
    const download: ArtifactDownload = (request) =>
      Effect.succeed({
        bytes: deb,
        sha256: request.expectedSha256,
        path: join(request.directory, request.filename),
      });

    try {
      await mkdir(runtimeBinDir, { recursive: true });
      const result = await Effect.runPromise(
        Effect.either(
          ensureManagedNft({
            runtimeBinDir,
            download,
            cacheDir,
            platform: "linux",
            arch: "x64",
          }),
        ),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ProviderUnavailableError);
        expect(result.left.message).toMatch(/bundled loader libraries|nft --version/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips on non-Linux hosts", async () => {
    let downloads = 0;
    const download: ArtifactDownload = () => {
      downloads += 1;
      return Effect.succeed({ bytes: new Uint8Array(), sha256: "0".repeat(64), path: "unused" });
    };
    await Effect.runPromise(
      ensureManagedNft({
        runtimeBinDir: "/tmp/unused",
        download,
        cacheDir: "/tmp/unused-cache",
        platform: "darwin",
        arch: "arm64",
      }),
    );
    expect(downloads).toBe(0);
  });
});

describe("NFT_MANIFEST", () => {
  test("pins linux x64 and arm64 helper packages with https URLs and sha256", () => {
    expect(NFT_MANIFEST.schemaVersion).toBe(1);
    expect(NFT_MANIFEST.toolVersion).toBe(NFT_TOOL_VERSION);
    expect(Object.keys(NFT_MANIFEST.packages).sort()).toEqual(["linux-arm64", "linux-x64"]);
    for (const [host, packages] of Object.entries(NFT_MANIFEST.packages)) {
      expect(packages.length, host).toBeGreaterThanOrEqual(4);
      const names = packages.map((pkg) => pkg.name);
      expect(names).toContain("nftables");
      expect(names).toContain("libnftables1");
      expect(names).toContain("libgmp10");
      expect(names).toContain("libjansson4");
      expect(names).toContain("libedit2");
      expect(names).toContain("libtinfo6");
      expect(names).toContain("libbsd0");
      expect(names).toContain("libmd0");
      for (const pkg of packages) {
        expect(pkg.url, `${host} ${pkg.name} url`).toMatch(/^https:\/\//u);
        expect(pkg.sha256, `${host} ${pkg.name} sha256`).toMatch(/^[0-9a-f]{64}$/u);
        expect(pkg.sha256, `${host} ${pkg.name} sha256 is not a placeholder`).not.toMatch(/^0{64}$/u);
        expect(pkg.sizeBytes, `${host} ${pkg.name} size`).toBeGreaterThan(0);
      }
    }
  });

  test("wrapper script points netavark at the bundled nft without pasta", () => {
    expect(NFT_WRAPPER_SCRIPT).toContain("LD_LIBRARY_PATH");
    expect(NFT_WRAPPER_SCRIPT).toContain("/nft");
    expect(NFT_WRAPPER_SCRIPT).not.toContain("pasta");
    expect(NFT_WRAPPER_SCRIPT).not.toContain("network_backend");
  });
});

describe("setupProviderLando nft helper", () => {
  test("provisions nft into the linux runtime bin during setup", async () => {
    const { setupProviderLando } = await import("../src/setup.ts");
    const root = await mkdtemp(join(tmpdir(), "lando-setup-nft-"));
    const runtimeBinDir = join(root, "runtime", "bin");
    const runtimeConfigDir = join(root, "runtime", "config");
    const deb = makeSyntheticNftDeb();
    const download: ArtifactDownload = (request) =>
      Effect.succeed({
        bytes: deb,
        sha256: request.expectedSha256,
        path: join(request.directory, request.filename),
      });

    try {
      await mkdir(runtimeBinDir, { recursive: true });
      await Effect.runPromise(
        setupProviderLando({
          platform: "linux",
          podmanCommand: { version: Effect.succeed("podman version 6.0.1") },
          skipSocketProbe: true,
          runtimeBinDir,
          runtimeConfigDir,
          nftArtifactDownload: download,
          nftCacheDir: join(root, "nft-downloads"),
          stateDir: join(root, "state"),
        }),
      );
      expect(await hasUsableManagedNft(runtimeBinDir)).toBe(true);
      expect(await readFile(managedNftBinPath(runtimeBinDir), "utf8")).toBe(NFT_WRAPPER_SCRIPT);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
