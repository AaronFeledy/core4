import { describe, expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";

import { CompiledBinaryVersionError, buildCompiledBinary } from "../../../scripts/build-compiled-binary.ts";
import { windowsPeVersion } from "../../../scripts/windows-branding.ts";

const fixtureShimAssets = async (): Promise<readonly [string, string]> => [
  "/fixture/x64.gz",
  "/fixture/arm64.gz",
];

describe("compiled Windows branding", () => {
  test.each(["windows-x64", "windows-arm64"])("embeds the icon for %s on a Windows host", async (target) => {
    // Given: a Windows release target and the repository's ICO asset.
    const icon = resolve(import.meta.dirname, "../../../scripts/lando.ico");
    const outfile = "./dist/lando.exe";
    let received: Bun.BuildConfig | undefined;
    // When: the binary is compiled on a Windows host.
    await buildCompiledBinary(
      { target, outfile, version: "4.0.0-dev.1" },
      async (config) => {
        received = config;
        return { success: true, logs: [], outputs: [] };
      },
      fixtureShimAssets,
      target,
    );
    // Then: Bun receives all Lando metadata with a numeric PE version.
    expect(received?.compile).toEqual({
      target: `bun-${target}`,
      outfile,
      windows: {
        icon,
        title: "Lando",
        publisher: "Lando Alliance",
        description: "Lando",
        copyright: "MIT © Lando Alliance",
        version: "4.0.0",
      },
    });
    expect(await Bun.file(icon).slice(0, 4).bytes()).toEqual(Uint8Array.of(0, 0, 1, 0));
  });

  test.each(["4.0.0-dev.953", "4.0.0-dev.821+3.g2c29d89", "4.0.0-dev+2c29d89", "4.0.0-beta.1", "4.0.0"])(
    "derives a numeric PE version from %s",
    (version) => {
      // Given: a resolved prerelease or stable version.
      // When: it is converted for Bun's resource compiler.
      const actual = windowsPeVersion(version);
      // Then: prerelease and build metadata never reach the PE version field.
      expect(actual).toBe("4.0.0");
    },
  );

  test.each(["unknown", "4.0", "65536.0.0", "4.0.0.1"])("rejects an invalid PE core %s", (version) => {
    // Given: a version without a representable semver core.
    // When / Then: conversion reports the existing typed build-version failure.
    expect(() => windowsPeVersion(version)).toThrow(CompiledBinaryVersionError);
  });

  test.each([
    [
      "windows-x64",
      "linux-x64",
      [
        [
          "[build-compiled-binary] windows-x64: Bun cannot embed the Lando icon or version info when cross-compiling; this binary keeps Bun's defaults. Compile on Windows for a branded binary.",
        ],
      ],
    ],
    ["linux-x64", "windows-x64", []],
    ["windows-x64", "windows-x64", []],
  ] as const)("warns appropriately for %s on %s", async (target, host, expectedCalls) => {
    // Given: an explicit target/host pair and an observed warning channel.
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // When: a single build runs through the public builder.
      await buildCompiledBinary(
        { target, outfile: "./dist/lando", version: "4.0.0-dev.1" },
        async () => ({ success: true, logs: [], outputs: [] }),
        fixtureShimAssets,
        host,
      );
      // Then: only a Windows cross-compile reports unbranded output, exactly once.
      expect<unknown>(warning.mock.calls).toEqual(expectedCalls);
    } finally {
      warning.mockRestore();
    }
  });
});
