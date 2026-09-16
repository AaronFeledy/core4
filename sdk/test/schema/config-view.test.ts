import { expect, test } from "bun:test";
import { GlobalConfig, GlobalConfigView, JSON_SCHEMA_NAMES } from "@lando/sdk/schema";
import { Either, Schema } from "effect";

test("public view keeps maps and drops unknown state when encoding loaded config", () => {
  // Given
  const maps = { appEnv: { TEAM: "platform" }, appLabels: { team: "platform" } };
  const loaded = { ...Schema.decodeUnknownSync(GlobalConfig)(maps), privateState: { token: "opaque" } };
  // When
  const encoded = Schema.encodeSync(GlobalConfigView)(loaded);
  // Then
  expect(encoded).toMatchObject(maps);
  expect(encoded).not.toHaveProperty("privateState");
  expect(Schema.decodeUnknownSync(GlobalConfigView)(encoded)).toEqual(encoded);
});

test("public view rejects an invalid map when encoding", () => {
  // Given
  const loaded = Schema.decodeUnknownSync(GlobalConfig)({});
  // When
  const encoded = Schema.encodeUnknownEither(GlobalConfigView)({ ...loaded, appEnv: { TEAM: 42 } });
  // Then
  expect(Either.isLeft(encoded)).toBe(true);
});

test("public view participates in snapshot generation", () => {
  // Given / When
  const names = JSON_SCHEMA_NAMES;
  // Then
  expect(names).toContain("GlobalConfigView");
});
