import { gzipSync } from "node:zlib";
import type { ArtifactDownload, ProviderLayerOptions } from "@lando/provider-lando";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";

export const buildRuntimeTarGz = (
  entries: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`;
  for (const entry of entries) {
    const header = new Uint8Array(512);
    header.set(Buffer.from(entry.path, "latin1"), 0);
    header.set(Buffer.from(octal(0o644, 8), "ascii"), 100);
    header.set(Buffer.from(octal(0, 8), "ascii"), 108);
    header.set(Buffer.from(octal(0, 8), "ascii"), 116);
    header.set(Buffer.from(octal(entry.bytes.byteLength, 12), "ascii"), 124);
    header.set(Buffer.from(octal(0, 12), "ascii"), 136);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.set(Buffer.from("ustar\0", "ascii"), 257);
    header.set(Buffer.from("00", "ascii"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(Buffer.from(octal(checksum, 8), "ascii"), 148);
    chunks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks));
};

export const nativeInitBridgeFixture = () => {
  const elf = Buffer.alloc(120);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(62, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  const data = buildRuntimeTarGz([{ path: "./usr/bin/catatonit", bytes: elf }]);
  const ar = Buffer.from(
    `${"data.tar.gz".padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`,
  );
  const bytes = Buffer.concat([Buffer.from("!<arch>\n"), ar, data, Buffer.alloc(data.length % 2, 10)]);
  const licenseBytes = new TextEncoder().encode("fixture-catatonit-license\n");
  const pkg: NonNullable<ProviderLayerOptions["_catatonitPackage"]> = {
    source: { url: "https://example.invalid/source.tar.gz", sha256: sha256Hex(data), sizeBytes: data.length },
    url: "https://example.invalid/catatonit.deb",
    filename: "catatonit.deb",
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.length,
    binarySha256: sha256Hex(elf),
    binarySizeBytes: elf.length,
    elfMachine: 62,
    member: "./usr/bin/catatonit",
    version: "0.2.1-fixture",
    license: {
      spdx: "GPL-2.0-or-later",
      source: "https://example.invalid/source.tar.gz",
      texts: [{ file: "COPYING", url: "https://example.invalid/COPYING", sha256: sha256Hex(licenseBytes) }],
    },
  };
  const download: ArtifactDownload = (request) => {
    switch (request.url) {
      case pkg.url:
        return Effect.succeed({ bytes, sha256: pkg.sha256, path: "/fixture.deb" });
      case "https://example.invalid/COPYING":
        return Effect.succeed({
          bytes: licenseBytes,
          sha256: sha256Hex(licenseBytes),
          path: "/fixture-COPYING",
        });
      default:
        return Effect.die(new Error(`Unexpected native init fixture download: ${request.url}`));
    }
  };
  return { version: "0.1.7", elf, licenseBytes, pkg, download };
};
