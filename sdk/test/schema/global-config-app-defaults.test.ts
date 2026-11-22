import { describe, expect, test } from "bun:test";
import { GlobalConfig } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const decode = (input: unknown) => Schema.decodeUnknownResult(GlobalConfig)(input);

describe("GlobalConfig serviceDefaults", () => {
  test.each(["environment", "labels"] as const)(
    "accepts exactly 256 entries in serviceDefaults.%s",
    (field) => {
      const values = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`KEY_${index}`, "x"]));
      expect(Result.isSuccess(decode({ serviceDefaults: { [field]: values } }))).toBe(true);
    },
  );

  test("accepts bounded serviceDefaults environment and label maps", () => {
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      serviceDefaults: {
        environment: { APP_MODE: "development", LANDO_PLUGIN_ACME_TOKEN: "plugin-owned" },
        labels: { "com.example.team": "platform" },
      },
    });
    expect(config.serviceDefaults?.environment).toEqual({
      APP_MODE: "development",
      LANDO_PLUGIN_ACME_TOKEN: "plugin-owned",
    });
    expect(config.serviceDefaults?.labels).toEqual({ "com.example.team": "platform" });
  });

  test("rejects invalid and core-owned environment keys without reserving every LANDO-prefixed key", () => {
    expect(Result.isFailure(decode({ serviceDefaults: { environment: { "NOT-POSIX": "value" } } }))).toBe(
      true,
    );
    expect(Result.isFailure(decode({ serviceDefaults: { environment: { LANDO: "value" } } }))).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { environment: { LANDO_APP_NAME: "value" } } }))).toBe(
      true,
    );
    expect(
      Result.isSuccess(decode({ serviceDefaults: { environment: { LANDO_NOT_CORE_OWNED: "value" } } })),
    ).toBe(true);
  });

  test("enforces serviceDefaults.environment entry, value-byte, and encoded-map bounds", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "x"]));
    const oversizedValue = "é".repeat(16_385);
    const oversizedMap = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`KEY_${index}`, "x".repeat(32 * 1024)]),
    );
    expect(Result.isFailure(decode({ serviceDefaults: { environment: tooMany } }))).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { environment: { VALUE: oversizedValue } } }))).toBe(
      true,
    );
    expect(Result.isFailure(decode({ serviceDefaults: { environment: oversizedMap } }))).toBe(true);
  });

  test("enforces serviceDefaults.labels key, value-byte, map-byte, and reserved-prefix bounds", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`label.${index}`, "x"]));
    const oversizedValue = "é".repeat(2_049);
    const oversizedMap = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`label.${index}`, "x".repeat(4 * 1024)]),
    );
    expect(Result.isFailure(decode({ serviceDefaults: { labels: { "": "value" } } }))).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { labels: { ["x".repeat(254)]: "value" } } }))).toBe(
      true,
    );
    expect(Result.isFailure(decode({ serviceDefaults: { labels: { "bad=key": "value" } } }))).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { labels: { "bad\0key": "value" } } }))).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { labels: { "dev.lando.owner": "value" } } }))).toBe(
      true,
    );
    expect(Result.isFailure(decode({ serviceDefaults: { labels: tooMany } }))).toBe(true);
    expect(
      Result.isFailure(decode({ serviceDefaults: { labels: { "com.example.value": oversizedValue } } })),
    ).toBe(true);
    expect(Result.isFailure(decode({ serviceDefaults: { labels: oversizedMap } }))).toBe(true);
  });

  test("rejects removed appEnv and appLabels keys without decoding them", () => {
    const strict = (input: unknown) =>
      Schema.decodeUnknownResult(GlobalConfig)(input, { onExcessProperty: "error" });
    expect(Result.isFailure(strict({ appEnv: { TEAM: "platform" } }))).toBe(true);
    expect(Result.isFailure(strict({ appLabels: { team: "platform" } }))).toBe(true);
    expect(
      Schema.decodeUnknownSync(GlobalConfig)({ appEnv: { TEAM: "platform" } }).serviceDefaults,
    ).toBeUndefined();
  });
});
