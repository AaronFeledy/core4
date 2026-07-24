import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ProviderSetupConsentDeniedError } from "@lando/sdk/errors";
import { ProviderId, ProviderSetupPlan } from "@lando/sdk/schema";

describe("ProviderSetupPlan", () => {
  test("round-trips the closed Ubuntu 26.04 uidmap change", () => {
    // Given
    const encoded = {
      providerId: "lando",
      changes: [
        {
          _tag: "install-uidmap",
          platform: "linux",
          distribution: "ubuntu",
          version: "26.04",
          reason: "Rootless Podman needs uidmap helpers.",
        },
      ],
    };

    // When
    const decoded = Schema.decodeUnknownSync(ProviderSetupPlan)(encoded);
    const roundTrip = Schema.encodeSync(ProviderSetupPlan)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("rejects an unknown host-change tag", () => {
    // Given
    const encoded = {
      providerId: "lando",
      changes: [{ _tag: "package-install", packageName: "curl" }],
    };

    // When
    const result = Schema.decodeUnknownEither(ProviderSetupPlan)(encoded);

    // Then
    expect(Either.isLeft(result)).toBe(true);
  });

  test("publishes the consent-denied tagged error shape", () => {
    // Given
    const error = new ProviderSetupConsentDeniedError({
      providerId: ProviderId.make("lando"),
      change: "install-uidmap",
      message: "Provider setup consent was denied.",
      remediation: "Rerun setup with --yes or install uidmap manually.",
    });

    // When
    const encoded = Schema.encodeSync(ProviderSetupConsentDeniedError)(error);

    // Then
    expect(encoded).toEqual({
      _tag: "ProviderSetupConsentDeniedError",
      providerId: "lando",
      change: "install-uidmap",
      message: "Provider setup consent was denied.",
      remediation: "Rerun setup with --yes or install uidmap manually.",
    });
  });
});
