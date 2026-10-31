import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { assembleBundle, parseRuntimeBundleSources } from "../../../scripts/assemble-runtime-bundle.ts";
import {
  DebianArchiveError,
  extractDebianRegularMember,
  extractVerifiedDebianBinary,
  verifyStaticElfBinary,
} from "../../../scripts/runtime-bundle-debian.ts";
import type { RuntimeBundleDebianComponent } from "../../../scripts/runtime-bundle-sources.ts";
import { licenseBytes } from "./runtime-bundle-license-fixture.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const staticElf = (machine = 62, segment = 1): Uint8Array => {
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

const singleFileTarGz = (payload: Uint8Array, name: string, kind = 48): Uint8Array => {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000755\0", 100);
  header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124);
  header[156] = kind;
  header.write("ustar\0", 257);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const tar = Buffer.concat([header, payload, Buffer.alloc(((512 - (payload.length % 512)) % 512) + 1024)]);
  return gzipSync(tar);
};

const catatonitDeb = (elf: Uint8Array, kind = 48, member = "./usr/bin/catatonit"): Uint8Array => {
  const data = singleFileTarGz(elf, member, kind);
  const ar = Buffer.from(
    `${"data.tar.gz".padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`,
  );
  return Buffer.concat([Buffer.from("!<arch>\n"), ar, data, Buffer.alloc(data.length % 2, 10)]);
};

const catatonitSourceBytes = new TextEncoder().encode("catatonit-source-pin");
const catatonitSourcePin = {
  url: "https://example.test/catatonit-v0.2.1.tar.gz",
  sha256: sha256(catatonitSourceBytes),
  sizeBytes: catatonitSourceBytes.byteLength,
};
const debianCopyrightBytes = new TextEncoder().encode("debian-copyright-fixture");
const glibcCopyingLibBytes = new TextEncoder().encode("glibc-COPYING.LIB-fixture");
const glibcCopyrightBytes = new TextEncoder().encode("glibc-copyright-fixture");

const debianCatatonitFields = (
  elf: Uint8Array,
  deb: Uint8Array,
  hostKey: "linux-x64" | "linux-arm64" = "linux-x64",
) => ({
  name: "catatonit",
  license: {
    // Composite: catatonit GPL-2+ plus static-link glibc LGPL-2.1+ (Built-Using).
    spdx: "GPL-2.0-or-later AND LGPL-2.1-or-later",
    source: catatonitSourcePin.url,
    texts: [
      {
        file: "COPYING",
        url: "https://example.test/0.2.1/COPYING",
        sha256: sha256(licenseBytes),
      },
      {
        file: "copyright",
        url: "https://example.test/catatonit_0.2.1-2_copyright",
        sha256: sha256(debianCopyrightBytes),
      },
      {
        file: "COPYING.LIB",
        url: "https://example.test/glibc-2.41/COPYING.LIB",
        sha256: sha256(glibcCopyingLibBytes),
      },
      {
        file: "glibc-copyright",
        url: "https://example.test/glibc_2.41-12+deb13u4_copyright",
        sha256: sha256(glibcCopyrightBytes),
      },
    ],
  },
  version: "0.2.1-2+b14",
  archive: "deb" as const,
  url:
    hostKey === "linux-x64"
      ? "https://example.test/catatonit_0.2.1-2+b14_amd64.deb"
      : "https://example.test/catatonit_0.2.1-2+b14_arm64.deb",
  sha256: sha256(deb),
  sizeBytes: deb.length,
  source: catatonitSourcePin,
  member: "usr/bin/catatonit",
  binarySha256: sha256(elf),
  binarySizeBytes: elf.length,
  elfMachine: hostKey === "linux-x64" ? 62 : 183,
  installName: "bin/catatonit",
  mode: 493,
});

const debianComponent = (elf: Uint8Array, deb: Uint8Array): RuntimeBundleDebianComponent => {
  const sources = parseRuntimeBundleSources({
    schemaVersion: 1,
    runtimeVersion: "9.9.9-deb",
    bundles: {
      "linux-x64": {
        components: [debianCatatonitFields(elf, deb)],
      },
    },
  });
  const component = sources.bundles["linux-x64"]?.components[0];
  if (component === undefined || !("archive" in component) || component.archive !== "deb") {
    throw new Error("expected Debian catatonit fixture component");
  }
  return component;
};

const acceptVerification = async (): Promise<void> => {};
const acceptInspection = async (): Promise<string> =>
  "linux-vdso.so.1 (0x00007ffc00000000)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000000000)\n/lib64/ld-linux-x86-64.so.2 (0x00007f0000000000)\n";

describe("runtime-bundle debian extraction", () => {
  test("extracts only the regular member and rejects symlinks", async () => {
    const elf = staticElf();
    const fileDeb = catatonitDeb(elf, 48);
    const linkDeb = catatonitDeb(elf, 50);
    const bytes = await extractDebianRegularMember(fileDeb, "usr/bin/catatonit");
    expect(sha256(bytes)).toBe(sha256(elf));
    await expect(extractDebianRegularMember(linkDeb, "usr/bin/catatonit")).rejects.toBeInstanceOf(
      DebianArchiveError,
    );
  });

  test("rejects path traversal member names at extract time", async () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    await expect(extractDebianRegularMember(deb, "../usr/bin/catatonit")).rejects.toBeInstanceOf(
      DebianArchiveError,
    );
  });

  test("verifyStaticElfBinary accepts static ELF and rejects dynamic PT_INTERP", () => {
    const elf = staticElf(62, 1);
    const deb = catatonitDeb(elf);
    const component = debianComponent(elf, deb);
    expect(() => verifyStaticElfBinary(elf, component)).not.toThrow();
    const dynamic = staticElf(62, 3);
    expect(() =>
      verifyStaticElfBinary(dynamic, {
        ...component,
        binarySha256: sha256(dynamic),
        binarySizeBytes: dynamic.length,
      }),
    ).toThrow(/static|PT_INTERP|PT_DYNAMIC/i);
  });

  test("rejects wrong machine and wrong binary digest", () => {
    const elf = staticElf(62);
    const deb = catatonitDeb(elf);
    const component = debianComponent(elf, deb);
    const arm = staticElf(183);
    expect(() =>
      verifyStaticElfBinary(arm, { ...component, binarySha256: sha256(arm), binarySizeBytes: arm.length }),
    ).toThrow(/architecture|machine/i);
    expect(() =>
      verifyStaticElfBinary(staticElf(62), { ...component, binarySha256: "ab".repeat(32) }),
    ).toThrow(/digest|size/i);
  });
});

describe("runtime-bundle debian schema", () => {
  test("accepts typed deb components on Linux and rejects them elsewhere", () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "linux-x64": {
            components: [debianCatatonitFields(elf, deb)],
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "darwin-arm64": {
            components: [debianCatatonitFields(elf, deb, "linux-arm64")],
          },
        },
      }),
    ).toThrow(/Debian components are only valid on Linux/i);
  });

  test("rejects elfMachine that does not match the Linux host key", () => {
    const elf = staticElf(183);
    const deb = catatonitDeb(elf);
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "linux-x64": {
            components: [{ ...debianCatatonitFields(elf, deb), elfMachine: 183 }],
          },
        },
      }),
    ).toThrow(/elfMachine/i);
  });

  test.each(["member", "installName"] as const)("rejects unsafe deb %s paths", (field) => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "linux-x64": {
            components: [{ ...debianCatatonitFields(elf, deb), [field]: "../usr/bin/catatonit" }],
          },
        },
      }),
    ).toThrow();
  });

  test("requires an exact source archive pin and rejects license.source pointing at the .deb", () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    const base = debianCatatonitFields(elf, deb);
    const { source: _source, ...withoutSource } = base;
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: { "linux-x64": { components: [withoutSource] } },
      }),
    ).toThrow();
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "linux-x64": {
            components: [
              {
                ...base,
                license: { ...base.license, source: base.url },
              },
            ],
          },
        },
      }),
    ).toThrow(/license\.source must point at the source archive/i);
  });

  test("accepts license.source that names the upstream version under a Debian build suffix", () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    const base = debianCatatonitFields(elf, deb);
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-deb",
        bundles: {
          "linux-x64": {
            components: [
              {
                ...base,
                // URL names only upstream 0.2.1; component version is 0.2.1-2+b14
                license: {
                  ...base.license,
                  source: "https://example.test/archive/refs/tags/v0.2.1.tar.gz",
                },
                source: {
                  ...base.source,
                  url: "https://example.test/archive/refs/tags/v0.2.1.tar.gz",
                },
              },
            ],
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("assembleBundle debian components", () => {
  test("packs a verified static Debian member and fails closed on package corruption", async () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    const sources = parseRuntimeBundleSources({
      schemaVersion: 1,
      runtimeVersion: "9.9.9-deb",
      bundles: {
        "linux-x64": {
          components: [debianCatatonitFields(elf, deb)],
        },
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "rb-deb-ok-"));
    try {
      const result = await assembleBundle({
        repository: "AaronFeledy/core4",
        hostKey: "linux-x64",
        sources,
        outDir: dir,
        fetchArtifact: async (url) => {
          if (url.endsWith("/COPYING")) return licenseBytes;
          if (url.endsWith("/COPYING.LIB")) return glibcCopyingLibBytes;
          if (url.endsWith("catatonit_0.2.1-2_copyright")) return debianCopyrightBytes;
          if (url.endsWith("glibc_2.41-12+deb13u4_copyright")) return glibcCopyrightBytes;
          if (url.endsWith(".deb")) return deb;
          throw new Error(`unexpected ${url}`);
        },
        inspectCommand: acceptInspection,
        verifyCommand: acceptVerification,
      });
      expect(result.filename).toBe("lando-runtime-linux-x64.tar.gz");
      const extractDir = await mkdtemp(join(tmpdir(), "rb-deb-x-"));
      try {
        const proc = Bun.spawn(["tar", "-xzf", result.artifactPath, "-C", extractDir], {
          stdout: "inherit",
          stderr: "inherit",
        });
        expect(await proc.exited).toBe(0);
        const packed = new Uint8Array(await readFile(join(extractDir, "bin/catatonit")));
        expect(sha256(packed)).toBe(sha256(elf));
        const notices = await readFile(join(extractDir, "bin/licenses/THIRD_PARTY_NOTICES.md"), "utf8");
        expect(notices).toContain("catatonit 0.2.1-2+b14");
        expect(notices).toContain("GPL-2.0-or-later AND LGPL-2.1-or-later");
        expect(notices).toContain(catatonitSourcePin.url);
        expect(notices).not.toContain(debianCatatonitFields(elf, deb).url);
        expect(notices).toContain("catatonit/COPYING");
        expect(notices).toContain("catatonit/copyright");
        expect(notices).toContain("catatonit/COPYING.LIB");
        expect(notices).toContain("catatonit/glibc-copyright");
        expect(notices).toContain("https://example.test/glibc-2.41/COPYING.LIB");
        expect(notices).toContain("https://example.test/glibc_2.41-12+deb13u4_copyright");
        expect(new Uint8Array(await readFile(join(extractDir, "bin/licenses/catatonit/copyright")))).toEqual(
          debianCopyrightBytes,
        );
        expect(
          new Uint8Array(await readFile(join(extractDir, "bin/licenses/catatonit/COPYING.LIB"))),
        ).toEqual(glibcCopyingLibBytes);
        expect(
          new Uint8Array(await readFile(join(extractDir, "bin/licenses/catatonit/glibc-copyright"))),
        ).toEqual(glibcCopyrightBytes);
      } finally {
        await rm(extractDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const badDir = await mkdtemp(join(tmpdir(), "rb-deb-bad-"));
    try {
      await expect(
        assembleBundle({
          repository: "AaronFeledy/core4",
          hostKey: "linux-x64",
          sources,
          outDir: badDir,
          fetchArtifact: async (url) => {
            if (url.endsWith("/COPYING")) return licenseBytes;
            if (url.endsWith("/COPYING.LIB")) return glibcCopyingLibBytes;
            if (url.endsWith("catatonit_0.2.1-2_copyright")) return debianCopyrightBytes;
            if (url.endsWith("glibc_2.41-12+deb13u4_copyright")) return glibcCopyrightBytes;
            return new TextEncoder().encode("tampered-deb");
          },
          inspectCommand: acceptInspection,
          verifyCommand: acceptVerification,
        }),
      ).rejects.toThrow(/sha256|verify/i);
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  test("extracts the pinned executable only after package and ELF verification", async () => {
    const elf = staticElf();
    const deb = catatonitDeb(elf);
    const component = debianComponent(elf, deb);
    const bytes = await extractVerifiedDebianBinary(component, deb);
    expect(sha256(bytes)).toBe(sha256(elf));
  });
});
