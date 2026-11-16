import { describe, expect, test } from "bun:test";

import { SUPERCRONIC_PINS, SUPERCRONIC_VERSION } from "../src/supercronic.ts";

describe("supercronic pins", () => {
  test("pins distinct SHA-256 checksums and versioned GitHub release URLs for each architecture", () => {
    for (const [arch, artifact] of Object.entries(SUPERCRONIC_PINS.artifacts)) {
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      const url = new URL(artifact.url);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toBe(
        `/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-${arch}`,
      );
    }
    expect(SUPERCRONIC_PINS.artifacts.amd64.sha256).not.toBe(SUPERCRONIC_PINS.artifacts.arm64.sha256);
  });
});
