import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";

const PROVIDER_ID = "lando";

export const isIntelMacHost = (platform: HostPlatform | undefined, arch: string | undefined): boolean =>
  platform !== undefined &&
  hostPlatformFamily(platform) === "darwin" &&
  (arch === "x64" || arch === "x86_64");

export const INTEL_MAC_UNSUPPORTED_REMEDIATION =
  "Install Docker Desktop and run `lando setup --provider=docker`, or set `LANDO_PROVIDER=docker`. The managed Lando runtime does not support Intel macOS.";

export class IntelMacUnsupportedError extends ProviderUnavailableError {
  constructor(arch: string) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message:
        "Intel (x86_64) macOS is not supported because Podman 6 removed upstream support for Intel Macs.",
      details: { platform: "darwin", arch },
      remediation: INTEL_MAC_UNSUPPORTED_REMEDIATION,
    });
  }
}

export const rejectIntelMacHost = (
  platform: HostPlatform | undefined,
  arch: string | undefined,
): Effect.Effect<void, IntelMacUnsupportedError> =>
  isIntelMacHost(platform, arch) ? Effect.fail(new IntelMacUnsupportedError(arch ?? "x64")) : Effect.void;
