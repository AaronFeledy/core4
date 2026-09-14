import { expect, test } from "bun:test";
import { Schema } from "effect";

import { AppId, VolumeIdentity, VolumeInfo, VolumeLocator } from "@lando/sdk/schema";

test("preserves legacy volume consumers without inventing identity", () => {
  const result = Schema.decodeUnknownSync(VolumeInfo)({ ref: { app: AppId.make("app"), store: "data" } });
  expect(result.identity).toBeUndefined();
  expect(result.instanceId).toBeUndefined();
});

test("rejects an empty generation even when name and ownership are available", () => {
  const result = Schema.decodeUnknownEither(VolumeIdentity)({
    coordinationKey: "namespace-volume",
    nativeName: "volume",
    generation: "",
    ownerRoot: "/root",
    origin: "created",
  });
  expect(result._tag).toBe("Left");
});

test("keeps adopted generation separate from actual creation history", () => {
  const identity = {
    coordinationKey: "namespace-volume",
    nativeName: "volume",
    generation: "witness",
    ownerRoot: "/root",
    origin: "adopted",
  };
  const result = Schema.decodeUnknownSync(VolumeInfo)({
    ref: { app: "app", store: "volume" },
    identity,
    provenance: "legacy",
  });
  expect(result.identity?.origin).toBe("adopted");
  expect(result.instanceId).toBeUndefined();
  expect(result.provenance).toBe("legacy");
});

test("allows a pre-creation locator without fabricating a generation", () => {
  // Given a provider-native volume name in a stable endpoint namespace.
  const encoded = {
    coordinationKey: '["endpoint:unix:///run/podman.sock","native-data"]',
    nativeName: "native-data",
  };

  // When decoding the provider locator before the volume exists.
  const result = Schema.decodeUnknownSync(VolumeLocator)(encoded);

  // Then the stable physical key is retained without invented identity facts.
  expect(result).toEqual(encoded);
  expect(result.identity).toBeUndefined();
});
