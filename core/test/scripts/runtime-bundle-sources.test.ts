import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { parseRuntimeBundleSources } from "../../../scripts/runtime-bundle-sources.ts";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const sourcePins = (runtimeVersion: string): unknown => ({
  schemaVersion: 1,
  runtimeVersion,
  bundles: {
    "linux-x64": {
      components: [
        {
          name: "passt",
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
});
