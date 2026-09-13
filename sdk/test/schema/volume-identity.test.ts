import { expect, test } from "bun:test";
import { Schema } from "effect";

import { AppId, VolumeIdentity, VolumeInfo } from "@lando/sdk/schema";

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
