import { gzipSync } from "node:zlib";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import {
  CATATONIT_MANIFEST,
  type CatatonitPackage,
  LEGACY_NATIVE_INIT_BRIDGE_VERSION,
} from "../../src/catatonit-provision.ts";
import type { ArtifactDownload } from "../../src/runtime-bundle.ts";

export { LEGACY_NATIVE_INIT_BRIDGE_VERSION };

export const staticElf = (machine = 62, segment = 1): Uint8Array => {
  const elf = Buffer.alloc(120);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(machine, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(segment, 64);
  return elf;
};

export const singleFileTarGz = (elf: Uint8Array, name: string, kind = 48): Uint8Array => {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000755\0", 100);
  header.write(`${elf.length.toString(8).padStart(11, "0")}\0`, 124);
  header[156] = kind;
  header.write("ustar\0", 257);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const tar = Buffer.concat([header, elf, Buffer.alloc(((512 - (elf.length % 512)) % 512) + 1024)]);
  return gzipSync(tar);
};

export const catatonitDeb = (elf: Uint8Array, kind = 48, member = "./usr/bin/catatonit"): Uint8Array => {
  const data = singleFileTarGz(elf, member, kind);
  const ar = Buffer.from(
    `${"data.tar.gz".padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`,
  );
  return Buffer.concat([Buffer.from("!<arch>\n"), ar, data, Buffer.alloc(data.length % 2, 10)]);
};

export const catatonitFixture = (elf = staticElf(), kind = 48) => {
  const bytes = catatonitDeb(elf, kind);
  const licenseBytes = new TextEncoder().encode("fixture-catatonit-license\n");
  const base = CATATONIT_MANIFEST.packages.x64;
  const pkg: CatatonitPackage = {
    ...base,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.length,
    binarySha256: sha256Hex(elf),
    binarySizeBytes: elf.length,
    license: {
      spdx: base.license.spdx,
      source: base.license.source,
      texts: [
        {
          file: "COPYING",
          url: "https://example.invalid/catatonit-COPYING",
          sha256: sha256Hex(licenseBytes),
        },
      ],
    },
  };
  let downloads = 0;
  const download: ArtifactDownload = (request) =>
    Effect.sync(() => {
      downloads++;
      if (request.url === pkg.url) {
        return { bytes, sha256: pkg.sha256, path: "/fixture.deb" };
      }
      const text = pkg.license.texts.find((entry) => entry.url === request.url);
      if (text !== undefined) {
        return { bytes: licenseBytes, sha256: text.sha256, path: `/fixture-${text.file}` };
      }
      throw new Error(`unexpected download ${request.url}`);
    });
  return { elf, bytes, pkg, download, licenseBytes, downloads: () => downloads };
};
