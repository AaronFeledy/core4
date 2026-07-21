import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ProviderHostChangeRequest } from "@lando/sdk/schema";

describe("ProviderHostChangeRequest", () => {
  test("decodes and encodes a package-install request", () => {
    // Given
    const encoded = {
      _tag: "package-install",
      packageName: "uidmap",
      reason: "Rootless Podman requires subordinate ID mapping helpers.",
    } as const;

    // When
    const decoded = Schema.decodeUnknownSync(ProviderHostChangeRequest)(encoded);
    const roundTrip = Schema.encodeSync(ProviderHostChangeRequest)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("decodes and encodes an enable-user-linger request", () => {
    // Given
    const encoded = {
      _tag: "enable-user-linger",
      uid: 1000,
      reason: "Netavark requires the user systemd manager to remain available.",
    } as const;

    // When
    const decoded = Schema.decodeUnknownSync(ProviderHostChangeRequest)(encoded);
    const roundTrip = Schema.encodeSync(ProviderHostChangeRequest)(decoded);

    // Then
    expect(roundTrip).toEqual(encoded);
  });

  test("rejects an unknown request tag", () => {
    // Given
    const encoded = { _tag: "run-command", command: "loginctl" };

    // When
    const decode = () => Schema.decodeUnknownSync(ProviderHostChangeRequest)(encoded);

    // Then
    expect(decode).toThrow();
  });
});
