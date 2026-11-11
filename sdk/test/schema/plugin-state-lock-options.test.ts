import { describe, expect, test } from "bun:test";
import { PluginStateLockOptions } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

describe("plugin state lock options", () => {
  test("accepts finite bounded waits and rejects unbounded or invalid waits", () => {
    for (const timeoutMs of [0, 120_000, 600_000]) {
      const decoded = Schema.decodeUnknownResult(PluginStateLockOptions)({ timeoutMs });
      expect(Result.isSuccess(decoded)).toBe(true);
    }

    for (const timeoutMs of [-1, 600_001, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const decoded = Schema.decodeUnknownResult(PluginStateLockOptions)({ timeoutMs });
      expect(Result.isFailure(decoded)).toBe(true);
    }
  });
});
