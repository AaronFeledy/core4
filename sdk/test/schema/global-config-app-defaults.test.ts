import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

const decode = (input: unknown) => Schema.decodeUnknownResult(GlobalConfig)(input);

describe("GlobalConfig app defaults", () => {
  test.each(["appEnv", "appLabels"] as const)("accepts exactly 256 entries in %s", (field) => {
    // Given a map at the existing maximum, with keys valid for either field.
    const values = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`KEY_${index}`, "x"]));
    // When it crosses the runtime configuration boundary.
    const result = decode({ [field]: values });
    // Then the projection migration has not narrowed the runtime boundary.
    expect(Result.isSuccess(result)).toBe(true);
  });
  test("accepts bounded app environment and label maps", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      appEnv: { APP_MODE: "development", LANDO_PLUGIN_ACME_TOKEN: "plugin-owned" },
      appLabels: { "com.example.team": "platform" },
    });

    expect(config.appEnv).toEqual({ APP_MODE: "development", LANDO_PLUGIN_ACME_TOKEN: "plugin-owned" });
    expect(config.appLabels).toEqual({ "com.example.team": "platform" });
  });

  test("rejects invalid and core-owned environment keys without reserving every LANDO-prefixed key", () => {
    expect(Result.isFailure(decode({ appEnv: { "NOT-POSIX": "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appEnv: { LANDO: "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appEnv: { LANDO_APP_NAME: "value" } }))).toBe(true);
    expect(Result.isSuccess(decode({ appEnv: { LANDO_NOT_CORE_OWNED: "value" } }))).toBe(true);
  });

  test("enforces app environment entry, value-byte, and encoded-map bounds", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "x"]));
    const oversizedValue = "é".repeat(16_385);
    const oversizedMap = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`KEY_${index}`, "x".repeat(32 * 1024)]),
    );

    expect(Result.isFailure(decode({ appEnv: tooMany }))).toBe(true);
    expect(Result.isFailure(decode({ appEnv: { VALUE: oversizedValue } }))).toBe(true);
    expect(Result.isFailure(decode({ appEnv: oversizedMap }))).toBe(true);
  });

  test("enforces app label key, value-byte, map-byte, and reserved-prefix bounds", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`label.${index}`, "x"]));
    const oversizedValue = "é".repeat(2_049);
    const oversizedMap = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`label.${index}`, "x".repeat(4 * 1024)]),
    );

    expect(Result.isFailure(decode({ appLabels: { "": "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: { ["x".repeat(254)]: "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: { "bad=key": "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: { "bad\0key": "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: { "dev.lando.owner": "value" } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: tooMany }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: { "com.example.value": oversizedValue } }))).toBe(true);
    expect(Result.isFailure(decode({ appLabels: oversizedMap }))).toBe(true);
  });
});
