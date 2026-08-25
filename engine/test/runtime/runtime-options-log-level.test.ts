import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandoRuntimeOptions } from "../../src/runtime/runtime-options.ts";

describe("LandoRuntimeOptions logLevel baseline", () => {
  test("decodes when logLevel is omitted", () => {
    const decoded = Schema.decodeUnknownSync(LandoRuntimeOptions)({});
    expect("logLevel" in decoded).toBe(false);
    expect(decoded.logger).toBeUndefined();
    expect(decoded.renderer).toBeUndefined();
  });
});

describe("LandoRuntimeOptions.logLevel", () => {
  test("decodes a top-level logLevel string", () => {
    const decoded = Schema.decodeUnknownSync(LandoRuntimeOptions)({ logLevel: "debug" });
    expect(decoded.logLevel).toBe("debug");
    expect(decoded.logger).toBeUndefined();
  });

  test("decodes config.logLevel independently of logger", () => {
    const decoded = Schema.decodeUnknownSync(LandoRuntimeOptions)({
      logger: "pretty",
      config: { logLevel: "nope" },
    });
    expect(decoded.logger).toBe("pretty");
    expect(decoded.config?.logLevel).toBe("nope");
  });
});
