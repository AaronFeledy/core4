import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { HostPlatform } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";

export const isIntelMacHost = (platform: HostPlatform | undefined, arch: string | undefined): boolean =>
  platform === "darwin" && (arch === "x64" || arch === "x86_64");

export class IntelMacUnsupportedError extends ProviderUnavailableError {
  constructor(arch: string) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message:
        "Intel (x86_64) macOS is not supported because Podman 6 removed upstream support for Intel Macs.",
      details: { platform: "darwin", arch },
      remediation: "Run Lando on Apple Silicon macOS (arm64), Linux (x64/arm64), or Windows 11+ (x64).",
    });
  }
}
