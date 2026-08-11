import { describe, expect, test } from "bun:test";

// Type-only exports are proven by TypeScript under verbatimModuleSyntax, not at runtime.
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

describe("@lando/engine/operations/update barrel export surface", () => {
  test("exposes the locked runtime value-export names", async () => {
    // Given: the authoritative pre-refactor runtime export surface
    const expected = [...EXPECTED_RUNTIME_EXPORTS].sort();

    // When: the update operations barrel is loaded dynamically
    const module: Record<string, unknown> = await import("@lando/engine/operations/update");
    const actual = Object.keys(module).sort();

    // Then: runtime value exports match the locked surface exactly
    expect(actual).toEqual(expected);
  });
});
