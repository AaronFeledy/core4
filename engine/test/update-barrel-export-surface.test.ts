/** Locks the public update barrel's runtime and type-only export names. */
import { describe, expect, test } from "bun:test";

const EXPECTED_RUNTIME_EXPORTS = [
  "UpdateChecksumSignatureVerificationError",
  "UpdateChecksumVerificationError",
  "UpdateDowngradeError",
  "UpdateLaunchProbeError",
  "UpdateManifestReplayError",
  "UpdateMinimumVersionError",
  "UpdateNetworkError",
  "UpdatePermissionError",
  "UpdateResultSchema",
  "UpdateSignatureVerificationError",
  "buildWindowsReplacementScript",
  "defaultFetchManifestBytes",
  "resolveUpdateManifestUrl",
  "scheduleWindowsReplacement",
  "update",
  "updateChannelForVersion",
] as const;

const EXPECTED_TYPE_EXPORTS = [
  "UpdateChecksumSignatureInput",
  "UpdateChecksumSignatureVerifier",
  "UpdateError",
  "UpdateExecve",
  "UpdateExecveInput",
  "UpdateManifestFetcher",
  "UpdateManifestSignatureInput",
  "UpdateManifestSignatureVerifier",
  "UpdateOptions",
  "UpdateRename",
  "UpdateResult",
  "UpdateSelfUpdateOptions",
  "UpdateWindowsReplacement",
  "UpdateWindowsReplacementInput",
  "UpdateWindowsReplacementSpawnInput",
  "UpdateWindowsReplacementSpawner",
] as const;

describe("@lando/engine/operations/update barrel export surface", () => {
  test("exposes the locked runtime value-export names", async () => {
    // Given: the locked runtime export surface
    const expected = [...EXPECTED_RUNTIME_EXPORTS].sort();

    // When: the update operations barrel is loaded dynamically
    const module: Record<string, unknown> = await import("@lando/engine/operations/update");
    const actual = Object.keys(module).sort();

    // Then: runtime value exports match the locked surface exactly
    expect(actual).toEqual(expected);
  });

  test("exposes the locked type-only export names", async () => {
    // Given: the locked type-only export surface
    const expected = [...EXPECTED_TYPE_EXPORTS].sort();

    // When: type-only export declarations are read from the source barrel
    const source = await Bun.file(new URL("../src/operations/update.ts", import.meta.url)).text();
    const actual = [...source.matchAll(/export type\s*\{([^}]*)\}\s*from/gu)]
      .flatMap((match) => (match[1] ?? "").split(","))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort();

    // Then: erased type exports match the locked surface exactly
    expect(actual).toEqual(expected);
  });
});
