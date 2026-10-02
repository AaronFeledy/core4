import { expect, test } from "bun:test";
import { Schema } from "effect";

import { VolumeCreationFact, VolumeInitializationRecord } from "@lando/sdk/schema";

const identity = {
  coordinationKey: "daemon/data",
  nativeName: "data",
  generation: "one",
  ownerRoot: "/owner",
  origin: "created",
};

test("creation facts require generation and canonical owner", () => {
  expect(Schema.is(VolumeCreationFact)(identity)).toBe(true);
  expect(Schema.decodeUnknownResult(VolumeCreationFact)({ nativeName: "data" })._tag).toBe("Left");
});

test("initialization outcomes require the claiming operation", () => {
  expect(
    Schema.decodeUnknownResult(VolumeInitializationRecord)({ identity, state: { _tag: "fresh" } })._tag,
  ).toBe("Right");
  expect(
    Schema.decodeUnknownResult(VolumeInitializationRecord)({ identity, state: { _tag: "seeded" } })._tag,
  ).toBe("Left");
  expect(
    Schema.decodeUnknownResult(VolumeInitializationRecord)({
      identity,
      state: { _tag: "failed", operationId: "op" },
    })._tag,
  ).toBe("Right");
});
