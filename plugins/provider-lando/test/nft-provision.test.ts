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
  collectNftDebPayload,
  ensureManagedNft,
  extractNftFromDeb,
  hasUsableManagedNft,
  managedNftBinPath,
  managedNftLibDir,
  managedNftVersionPath,
  parseArMembers,
  parseTarEntries,
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
