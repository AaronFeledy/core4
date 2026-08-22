export interface CiPlatform {
  readonly id: string;
  readonly runsOn: string;
  readonly bunTarget: string;
  readonly binaryName: string;
  readonly timeoutMinutes: number;
  readonly providerTimeoutMinutes: number;
  readonly liveProviderIntegration: boolean;
}

/**
 * GitHub-hosted Ubuntu x64 runners covered by Linux CI test jobs.
 * Keep the older LTS (24.04) as the primary/reference runner for portable
 * glibc builds; also exercise the newer preview runner (26.04).
 */
export const LINUX_X64_CI_RUNNERS = ["ubuntu-24.04", "ubuntu-26.04"] as const;
export type LinuxX64CiRunner = (typeof LINUX_X64_CI_RUNNERS)[number];

/** Reference Linux x64 runner — older glibc for portable compiled binaries. */
export const LINUX_X64_PRIMARY_RUNNER: LinuxX64CiRunner = "ubuntu-24.04";

export const isWindowsCiPlatform = (platform: Pick<CiPlatform, "id">): boolean =>
  platform.id.startsWith("windows-");

export const releaseBinaryFileName = (platform: Pick<CiPlatform, "id">): string =>
  `lando-${platform.id}${isWindowsCiPlatform(platform) ? ".exe" : ""}`;

export const CI_PLATFORMS: ReadonlyArray<CiPlatform> = [
  {
    id: "darwin-arm64",
    runsOn: "macos-15",
    bunTarget: "bun-darwin-arm64",
    binaryName: "lando",
    timeoutMinutes: 30,
    providerTimeoutMinutes: 20,
    liveProviderIntegration: false,
  },
  {
    id: "darwin-x64",
    runsOn: "macos-15-intel",
    bunTarget: "bun-darwin-x64",
    binaryName: "lando",
    timeoutMinutes: 30,
    providerTimeoutMinutes: 20,
    liveProviderIntegration: false,
  },
  {
    id: "linux-arm64",
    runsOn: "ubuntu-24.04-arm",
    bunTarget: "bun-linux-arm64",
    binaryName: "lando",
    timeoutMinutes: 30,
    providerTimeoutMinutes: 25,
    liveProviderIntegration: false,
  },
  {
    id: "linux-x64",
    runsOn: LINUX_X64_PRIMARY_RUNNER,
    bunTarget: "bun-linux-x64",
    binaryName: "lando",
    timeoutMinutes: 30,
    providerTimeoutMinutes: 25,
    liveProviderIntegration: true,
  },
  {
    id: "windows-x64",
    runsOn: "windows-2022",
    bunTarget: "bun-windows-x64",
    binaryName: "lando-windows-x64.exe",
    timeoutMinutes: 35,
    providerTimeoutMinutes: 20,
    liveProviderIntegration: false,
  },
  {
    id: "windows-arm64",
    // Native GitHub-hosted ARM Windows runner used by oven-sh/setup-bun.
    // windows-11-vs2026-arm is the VS2026 image; GH migrates windows-11-arm
    // onto it by 2026-09-30. Prefer the stable windows-11-arm label.
    runsOn: "windows-11-arm",
    bunTarget: "bun-windows-arm64",
    binaryName: "lando-windows-arm64.exe",
    timeoutMinutes: 35,
    providerTimeoutMinutes: 20,
    liveProviderIntegration: false,
  },
];
