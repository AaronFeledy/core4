import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as SDK from "@lando/sdk/schema";

describe("ScannerConfig", () => {
  test.each([false, {}, { path: "/healthz", okCodes: [200, 301], retries: 3, timeout: 5000 }])(
    "decodes valid scanner settings %j",
    (input) => {
      // Given valid authored settings, when decoded, then preserve them.
      expect(Schema.decodeUnknownSync(SDK.ScannerConfig)(input)).toEqual(input);
    },
  );

  test.each([
    { retries: -1 },
    { retries: 21 },
    { retries: 1.5 },
    { timeout: 0 },
    { timeout: 600001 },
    { timeout: 1.5 },
    { okCodes: [600] },
    { okCodes: [99] },
    { okCodes: [200.5] },
    { path: "healthz" },
  ])("rejects invalid scanner settings %j", (input) => {
    // Given invalid settings, when decoded, then report a schema failure.
    expect(Either.isLeft(Schema.decodeUnknownEither(SDK.ScannerConfig)(input))).toBe(true);
  });

  test.each([false, {}, { path: "/", okCodes: [100, 599], retries: 20, timeout: 600000 }])(
    "shares scanner settings between global and service config %j",
    (scanner) => {
      // Given shared authored settings, when each config is decoded, then preserve scanner.
      expect(Schema.decodeUnknownSync(SDK.GlobalConfig)({ scanner })).toHaveProperty("scanner", scanner);
      expect(Schema.decodeUnknownSync(SDK.ServiceConfig)({ scanner })).toHaveProperty("scanner", scanner);
    },
  );
});
