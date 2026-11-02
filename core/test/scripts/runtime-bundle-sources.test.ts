import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { parseRuntimeBundleSources } from "../../../scripts/runtime-bundle-sources.ts";
import { fixtureLicense } from "./runtime-bundle-license-fixture.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const sourcePins = (runtimeVersion: string): unknown => ({
  schemaVersion: 1,
  runtimeVersion,
  bundles: {
    "linux-x64": {
      components: [
        {
          name: "passt",
          license: fixtureLicense("2026_06_11.a9c61ff"),
          version: "2026_06_11.a9c61ff",
          sourceBuild: "passt-linux-native",
          inputs: [
            {
              name: "source",
              url: "https://example.test/passt.tar.xz",
              sha256: sha256("source"),
              archive: "tar.xz",
            },
          ],
          outputs: [{ source: "passt", installName: "bin/passt", mode: 493 }],
        },
      ],
    },
  },
});

describe("runtime-bundle source pins", () => {
  test("accepts shell-safe runtime versions", () => {
    expect(parseRuntimeBundleSources(sourcePins("0.1.1")).runtimeVersion).toBe("0.1.1");
    expect(parseRuntimeBundleSources(sourcePins("9.9.9-fixture")).runtimeVersion).toBe("9.9.9-fixture");
  });

  test.each([
    "0.1.1$(echo pwned)",
    "0.1.1 pwned",
    "0.1.1\npwned",
    "../0.1.1",
    '0.1.1"pwned',
    "0.1.1'pwned",
    "0.1.1;pwned",
    "0.1.1|pwned",
    "0.1.1&pwned",
    "0.1.1`pwned`",
    "0.1.1>pwned",
    "0.1.1<pwned",
  ])("rejects shell-unsafe runtime version %p", (runtimeVersion) => {
    expect(() => parseRuntimeBundleSources(sourcePins(runtimeVersion))).toThrow();
  });

  test("rejects vendor source-build inputs with archives the builder cannot extract", () => {
    expect(() =>
      parseRuntimeBundleSources({
        schemaVersion: 1,
        runtimeVersion: "9.9.9-fixture",
        bundles: {
          "linux-x64": {
            components: [
              {
                name: "netavark",
                license: fixtureLicense("2.0.0"),
                version: "2.0.0",
                sourceBuild: "netavark-linux-native",
                inputs: [
                  {
                    name: "source",
                    url: "https://example.test/netavark.tar.xz",
                    sha256: sha256("source"),
                    archive: "tar.xz",
                  },
                  {
                    name: "vendor",
                    url: "https://example.test/netavark-vendor.tar.xz",
                    sha256: sha256("vendor"),
                    archive: "tar.xz",
                  },
                ],
                outputs: [{ source: "target/release/netavark", installName: "bin/netavark", mode: 493 }],
              },
            ],
          },
        },
      }),
    ).toThrow(/vendor.*tar\.gz/i);
  });

  test("Linux catatonit pins composite SPDX with verified static glibc license texts", async () => {
    const { readRuntimeBundleSources } = await import("../../../scripts/runtime-bundle-sources.ts");
    const sources = await readRuntimeBundleSources();
    expect(sources.runtimeVersion).toBe("0.1.8");
    for (const hostKey of ["linux-x64", "linux-arm64"] as const) {
      const catatonit = sources.bundles[hostKey]?.components.find(
        (component) => component.name === "catatonit",
      );
      if (catatonit === undefined || !("archive" in catatonit) || catatonit.archive !== "deb") {
        throw new Error(`missing Debian catatonit on ${hostKey}`);
      }
      expect(catatonit.license.spdx).toBe("GPL-2.0-or-later AND LGPL-2.1-or-later");
      const byFile = new Map(catatonit.license.texts.map((text) => [text.file, text]));
      expect(byFile.get("COPYING")?.sha256).toBe(
        "8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643",
      );
      expect(byFile.get("copyright")?.sha256).toBe(
        "91b658413f8fa63a40060bb18aac958d407d454c0827c6fe78c003ea10d2018b",
      );
      // Upstream LGPL-2.1 text for glibc-2.41 (Built-Using glibc (= 2.41-12+deb13u4)).
      expect(byFile.get("COPYING.LIB")).toEqual({
        file: "COPYING.LIB",
        url: "https://raw.githubusercontent.com/bminor/glibc/glibc-2.41/COPYING.LIB",
        sha256: "dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551",
      });
      // Debian source/copyright for the exact Built-Using version (not a placeholder).
      expect(byFile.get("glibc-copyright")).toEqual({
        file: "glibc-copyright",
        url: "https://metadata.ftp-master.debian.org/changelogs/main/g/glibc/glibc_2.41-12+deb13u4_copyright",
        sha256: "f5788886720a2605a946e81d571e6c8162b09f58d2e2ceb8d36e5768fccd850d",
      });
      // license.source stays the catatonit source archive, not the binary .deb.
      expect(catatonit.license.source).toBe(catatonit.source.url);
      expect(catatonit.license.source).not.toBe(catatonit.url);
    }
  });
});
