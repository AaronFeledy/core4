import { describe, expect, test } from "bun:test";

import { SUPERCRONIC_PINS, type SupercronicPins, validateSupercronicPins } from "../src/supercronic.ts";

describe("supercronic pins", () => {
  test("accepts the committed version and per-arch checksums", () => {
    expect(() => validateSupercronicPins(SUPERCRONIC_PINS)).not.toThrow();
    expect(SUPERCRONIC_PINS.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(SUPERCRONIC_PINS.artifacts.amd64.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(SUPERCRONIC_PINS.artifacts.arm64.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("fails if the supercronic version pin is missing", () => {
    const pins: SupercronicPins = { ...SUPERCRONIC_PINS, version: "" };
    expect(() => validateSupercronicPins(pins)).toThrow("supercronic version pin is missing");
  });

  test("fails if a checksum pin is missing", () => {
    const pins: SupercronicPins = {
      ...SUPERCRONIC_PINS,
      artifacts: {
        ...SUPERCRONIC_PINS.artifacts,
        amd64: { ...SUPERCRONIC_PINS.artifacts.amd64, sha256: "" },
      },
    };
    expect(() => validateSupercronicPins(pins)).toThrow("supercronic amd64 checksum pin is missing");
  });
});
