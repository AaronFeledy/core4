import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type ManifestInvariantViolation,
  REQUIRED_RUNTIME_HOST_KEYS,
  checkRuntimeBundleManifestInvariant,
  parseGitHubRepository,
  verifyRuntimeBundleManifestUrls,
} from "../../../scripts/check-runtime-bundle-manifest.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const MANIFEST_PATH = resolve(repoRoot, "plugins/provider-lando/runtime-bundle-versions.json");
const VERSION_PATH = resolve(repoRoot, "plugins/provider-lando/runtime-bundle-version");
const PLACEHOLDER_FIXTURE_PATH = resolve(
  import.meta.dirname,
  "fixtures/runtime-bundle-manifest-placeholder.json",
);

const EXPECTED_REPOSITORY = "AaronFeledy/core4";

const validEntry = (host: string, ext = "tar.gz") => ({
  url: `https://github.com/${EXPECTED_REPOSITORY}/releases/download/runtime-v0.1.0/lando-runtime-${host}.${ext}`,
  sha256: "3b45e11fb652fe1fd6ca2fa2c9781ec3dc137efed6a9ff3e7e3a0859644ca490",
  filename: `lando-runtime-${host}.${ext}`,
  sizeBytes: 36_666_820,
});

const validManifest = () => ({
  schemaVersion: 1,
  runtimeVersion: "0.1.0",
  bundles: {
    "linux-x64": validEntry("linux-x64"),
    "linux-arm64": validEntry("linux-arm64"),
    "darwin-arm64": validEntry("darwin-arm64"),
    "win32-x64": validEntry("win32-x64", "zip"),
  },
});

const messages = (violations: ReadonlyArray<ManifestInvariantViolation>): string =>
  violations.map((violation) => `${violation.key}: ${violation.message}`).join("\n");

describe("runtime-bundle manifest offline invariant", () => {
  test("the committed manifest passes against this repository", async () => {
    const [manifestText, runtimeVersionFile] = await Promise.all([
      readFile(MANIFEST_PATH, "utf8"),
      readFile(VERSION_PATH, "utf8"),
    ]);
    const result = checkRuntimeBundleManifestInvariant({
      manifest: JSON.parse(manifestText),
      runtimeVersionFile,
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok, messages(result.violations)).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("a well-formed synthetic manifest passes", () => {
    const result = checkRuntimeBundleManifestInvariant({
      manifest: validManifest(),
      runtimeVersionFile: "0.1.0\n",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok, messages(result.violations)).toBe(true);
  });

  test("the pre-US-411 placeholder manifest fails on every invariant class", async () => {
    const manifest = JSON.parse(await readFile(PLACEHOLDER_FIXTURE_PATH, "utf8"));
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0\n",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    const joined = messages(result.violations);
    // placeholder checksums
    expect(joined).toContain("placeholder or malformed checksum");
    // sizeBytes: 0
    expect(joined).toContain("sizeBytes must be a positive integer");
    // off-repository / non-runtime-v* URL
    expect(joined).toContain("is not under this repository's release path");
    // extra darwin-x64 host key (Podman 6 drops Intel Mac)
    expect(joined).toContain('unexpected host key "darwin-x64"');
  });

  test("a runtimeVersion that drifts from the version file is a violation", () => {
    const manifest = { ...validManifest(), runtimeVersion: "0.2.0" };
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0\n",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain('does not match runtime-bundle-version file "0.1.0"');
  });

  test("an all-zero-style placeholder checksum is rejected", () => {
    const manifest = validManifest();
    manifest.bundles["linux-x64"].sha256 = "0000000000000000000000000000000000000000000000000000000000000001";
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("placeholder or malformed checksum");
  });

  test("sizeBytes: 0 is rejected", () => {
    const manifest = validManifest();
    manifest.bundles["linux-x64"].sizeBytes = 0;
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("sizeBytes must be a positive integer");
  });

  test("an off-repository URL is rejected", () => {
    const manifest = validManifest();
    manifest.bundles["linux-x64"].url =
      "https://github.com/someone-else/core4/releases/download/runtime-v0.1.0/lando-runtime-linux-x64.tar.gz";
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("is not under this repository's release path");
  });

  test("a non-runtime-v tag in the URL is rejected", () => {
    const manifest = validManifest();
    manifest.bundles["linux-x64"].url =
      "https://github.com/AaronFeledy/core4/releases/download/v0.1.0/lando-runtime-linux-x64.tar.gz";
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("is not under this repository's release path");
  });

  test("a non-HTTPS URL is rejected", () => {
    const manifest = validManifest();
    manifest.bundles["linux-x64"].url =
      "http://github.com/AaronFeledy/core4/releases/download/runtime-v0.1.0/lando-runtime-linux-x64.tar.gz";
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("must be an HTTPS URL");
  });

  test("a missing required host key is a violation", () => {
    const full = validManifest();
    const { "win32-x64": _omitted, ...bundles } = full.bundles;
    const manifest = { ...full, bundles };
    const result = checkRuntimeBundleManifestInvariant({
      manifest,
      runtimeVersionFile: "0.1.0",
      expectedRepository: EXPECTED_REPOSITORY,
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain('missing required host key "win32-x64"');
  });

  test("the required host-key set excludes darwin-x64 and windows-x64", () => {
    expect([...REQUIRED_RUNTIME_HOST_KEYS]).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
      "win32-x64",
    ]);
    expect(REQUIRED_RUNTIME_HOST_KEYS).not.toContain("darwin-x64");
    expect(REQUIRED_RUNTIME_HOST_KEYS).not.toContain("windows-x64");
  });
});

describe("parseGitHubRepository", () => {
  test("parses SSH and HTTPS remotes", () => {
    expect(parseGitHubRepository("git@github.com:AaronFeledy/core4.git")).toBe("AaronFeledy/core4");
    expect(parseGitHubRepository("https://github.com/AaronFeledy/core4.git")).toBe("AaronFeledy/core4");
    expect(parseGitHubRepository("https://github.com/AaronFeledy/core4")).toBe("AaronFeledy/core4");
    expect(parseGitHubRepository("git@gitlab.com:AaronFeledy/core4.git")).toBeUndefined();
  });
});

describe("runtime-bundle manifest live verification", () => {
  const okResponse = (length: number): Response =>
    new Response(null, { status: 200, headers: { "content-length": String(length) } });

  test("passes when every URL returns 200 with a matching Content-Length", async () => {
    const result = await verifyRuntimeBundleManifestUrls({
      manifest: validManifest(),
      fetchImpl: async () => okResponse(36_666_820),
    });
    expect(result.ok, messages(result.violations)).toBe(true);
  });

  test("fails when a URL returns a non-200 status", async () => {
    const result = await verifyRuntimeBundleManifestUrls({
      manifest: validManifest(),
      fetchImpl: async (url) =>
        String(url).includes("linux-x64") ? new Response(null, { status: 404 }) : okResponse(36_666_820),
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("returned 404, expected 200");
  });

  test("fails when Content-Length does not match the recorded sizeBytes", async () => {
    const result = await verifyRuntimeBundleManifestUrls({
      manifest: validManifest(),
      fetchImpl: async () => okResponse(999),
    });
    expect(result.ok).toBe(false);
    expect(messages(result.violations)).toContain("does not match recorded sizeBytes");
  });
});
