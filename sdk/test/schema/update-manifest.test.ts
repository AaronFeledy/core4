import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { UpdateManifestSchema } from "../../src/schema/index.ts";

const hex = "a".repeat(64);

const decodeManifest = (manifest: unknown) =>
  Schema.decodeUnknownEither(UpdateManifestSchema)(manifest, { onExcessProperty: "error" });

const validManifest = {
  channel: "next",
  latest: "4.2.0",
  released: "2026-06-17T00:00:00.000Z",
  minimum: "4.0.0",
  binaries: {
    "darwin-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-x64",
      sha256: hex,
      size: 1,
    },
    "darwin-arm64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-darwin-arm64",
      sha256: hex,
      size: 1,
    },
    "linux-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-linux-x64",
      sha256: hex,
      size: 1,
    },
    "linux-arm64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-linux-arm64",
      sha256: hex,
      size: 1,
    },
    "windows-x64": {
      url: "https://github.com/lando/lando/releases/download/v4.2.0/lando-windows-x64.exe",
      sha256: hex,
      size: 1,
    },
  },
  checksums: {
    url: "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS",
    signature: "https://github.com/lando/lando/releases/download/v4.2.0/SHA256SUMS.sig",
  },
  notes: "https://github.com/lando/lando/releases/tag/v4.2.0",
};

describe("UpdateManifestSchema", () => {
  test("validates channel, latest version, minimum, artifact URLs, checksums, signatures, and platform entries", () => {
    const decoded = decodeManifest(validManifest);

    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.channel).toBe("next");
      expect(decoded.right.binaries["linux-x64"].sha256).toBe(hex);
      expect(decoded.right.checksums.signature.endsWith("SHA256SUMS.sig")).toBe(true);
    }
  });

  test("rejects an unsupported channel", () => {
    const decoded = decodeManifest({ ...validManifest, channel: "beta" });

    expect(Either.isLeft(decoded)).toBe(true);
  });

  test("rejects insecure artifact URLs and missing platform entries", () => {
    const insecure = structuredClone(validManifest);
    insecure.binaries["linux-x64"].url = "http://example.test/lando-linux-x64";
    const withoutWindows = structuredClone(validManifest);
    Reflect.deleteProperty(withoutWindows.binaries, "windows-x64");

    expect(Either.isLeft(decodeManifest(insecure))).toBe(true);
    expect(Either.isLeft(decodeManifest(withoutWindows))).toBe(true);
  });
});
