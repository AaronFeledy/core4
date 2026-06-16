export interface CiPlatform {
  readonly id: string;
  readonly runsOn: string;
  readonly bunTarget: string;
  readonly binaryName: string;
  readonly timeoutMinutes: number;
  readonly providerTimeoutMinutes: number;
  readonly liveProviderIntegration: boolean;
}

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
    runsOn: "ubuntu-24.04",
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
];
