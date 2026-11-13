/**
 * Pinned supercronic release used to run scheduled jobs inside cloned sidecars.
 *
 * Upstream: https://github.com/aptible/supercronic/releases/tag/v0.2.51
 * License: MIT (GitHub license API key `mit` on aptible/supercronic).
 * Checksums were verified against GitHub release asset digests and by hashing
 * the downloaded linux-amd64 and linux-arm64 binaries.
 */
export const SUPERCRONIC_VERSION = "0.2.51" as const;
export const SUPERCRONIC_LICENSE = "MIT" as const;
export const SUPERCRONIC_BIN = "/usr/local/bin/supercronic" as const;
export const SUPERCRONIC_CRONTAB = "/usr/local/etc/supercronic/crontab" as const;

const SHA256 = /^[0-9a-f]{64}$/u;

export const SUPERCRONIC_ARTIFACTS = {
  amd64: {
    url: `https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64`,
    sha256: "cc232108374e8e2b537045f2d5eaa1229f619db314c3ba6a14d38b35dc0aa123",
  },
  arm64: {
    url: `https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-arm64`,
    sha256: "4ae22576a78223d8ccdf5f3b3660a5cbb5288416bf0ca96afc4a36d195932b94",
  },
} as const;

export type SupercronicArch = keyof typeof SUPERCRONIC_ARTIFACTS;

export interface SupercronicPins {
  readonly version: string;
  readonly license: string;
  readonly artifacts: {
    readonly amd64: { readonly url: string; readonly sha256: string };
    readonly arm64: { readonly url: string; readonly sha256: string };
  };
}

export const SUPERCRONIC_PINS: SupercronicPins = {
  version: SUPERCRONIC_VERSION,
  license: SUPERCRONIC_LICENSE,
  artifacts: SUPERCRONIC_ARTIFACTS,
};

export const validateSupercronicPins = (pins: SupercronicPins): void => {
  if (!/^\d+\.\d+\.\d+$/u.test(pins.version)) {
    throw new Error("supercronic version pin is missing");
  }
  if (pins.license !== "MIT") {
    throw new Error("supercronic license pin is missing");
  }
  for (const arch of ["amd64", "arm64"] as const) {
    const artifact = pins.artifacts[arch];
    if (artifact === undefined || artifact.url.length === 0) {
      throw new Error(`supercronic ${arch} url pin is missing`);
    }
    if (!SHA256.test(artifact.sha256)) {
      throw new Error(`supercronic ${arch} checksum pin is missing`);
    }
  }
};

export const SUPERCRONIC_STEP_ID = "schedule.supercronic" as const;
export const SUPERCRONIC_CRONTAB_STEP_ID = "schedule.crontab" as const;

export const supercronicCommand = (): readonly string[] => [
  SUPERCRONIC_BIN,
  "-overlapping",
  SUPERCRONIC_CRONTAB,
];
