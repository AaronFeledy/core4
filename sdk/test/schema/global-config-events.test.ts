import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

describe("GlobalConfig.events", () => {
  test("accepts a positive integer delivery queue capacity", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      events: { deliveryQueueCapacity: 32 },
    });

    expect(decoded.events?.deliveryQueueCapacity).toBe(32);
  });

  test("accepts the maximum delivery queue capacity", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      events: { deliveryQueueCapacity: 65_536 },
    });

    expect(decoded.events?.deliveryQueueCapacity).toBe(65_536);
  });

  test("rejects zero and fractional delivery queue capacities", () => {
    const zero = Schema.decodeUnknownEither(GlobalConfig)({
      events: { deliveryQueueCapacity: 0 },
    });
    const fractional = Schema.decodeUnknownEither(GlobalConfig)({
      events: { deliveryQueueCapacity: 1.5 },
    });

    expect(Either.isLeft(zero)).toBe(true);
    expect(Either.isLeft(fractional)).toBe(true);
  });

  test("rejects a delivery queue capacity above the maximum", () => {
    const aboveMaximum = Schema.decodeUnknownEither(GlobalConfig)({
      events: { deliveryQueueCapacity: 65_537 },
    });

    expect(Either.isLeft(aboveMaximum)).toBe(true);
  });
});
