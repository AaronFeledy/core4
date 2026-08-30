import { describe, expect, test } from "bun:test";

import { CI_PLATFORMS, PLATFORM_READINESS_CELLS } from "../../../scripts/ci-platforms.ts";

describe("platform readiness cells", () => {
  test("keeps liveProviderIntegration true only for linux-x64", () => {
    // Given: the CI platform catalog.
    // When: liveProviderIntegration is read per platform.
    // Then: only linux-x64 is true; every other platform is false.
    expect(
      CI_PLATFORMS.map((platform) => ({
        id: platform.id,
        liveProviderIntegration: platform.liveProviderIntegration,
      })),
    ).toEqual([
      { id: "darwin-arm64", liveProviderIntegration: false },
      { id: "darwin-x64", liveProviderIntegration: false },
      { id: "linux-arm64", liveProviderIntegration: false },
      { id: "linux-x64", liveProviderIntegration: true },
      { id: "windows-x64", liveProviderIntegration: false },
      { id: "windows-arm64", liveProviderIntegration: false },
    ]);
  });

  test("pins PLATFORM_READINESS_CELLS metadata", () => {
    // Given: the platform readiness cell table.
    // When: the exported rows are read.
    // Then: exactly six cells with locked id, provider, bundleKey, bundleMode, cadence, and runsOn.
    expect(PLATFORM_READINESS_CELLS).toHaveLength(6);
    expect(PLATFORM_READINESS_CELLS).toEqual([
      {
        id: "linux-x64",
        provider: "lando",
        bundleKey: "linux-x64",
        bundleMode: "current-commit",
        cadence: "pr+evidence",
        runsOn: "ubuntu-24.04",
      },
      {
        id: "linux-arm64",
        provider: "lando",
        bundleKey: "linux-arm64",
        bundleMode: "current-commit",
        cadence: "pr+evidence",
        runsOn: "ubuntu-24.04-arm",
      },
      {
        id: "darwin-arm64",
        provider: "lando",
        bundleKey: "darwin-arm64",
        bundleMode: "published",
        cadence: "evidence",
        runsOn: ["self-hosted", "lando-virt", "macOS", "ARM64"],
      },
      {
        id: "darwin-x64",
        provider: "docker",
        bundleKey: "none",
        bundleMode: "none",
        cadence: "evidence",
        runsOn: ["self-hosted", "lando-virt", "macOS", "X64"],
      },
      {
        id: "windows-x64",
        provider: "lando",
        bundleKey: "win32-x64",
        bundleMode: "current-commit",
        cadence: "evidence",
        runsOn: ["self-hosted", "lando-virt", "Windows", "X64"],
      },
      {
        id: "windows-arm64",
        provider: "lando",
        bundleKey: "win32-arm64",
        bundleMode: "current-commit",
        cadence: "evidence",
        runsOn: ["self-hosted", "lando-virt", "Windows", "ARM64"],
      },
    ]);
  });
});
