import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { GlobalConfig } from "../../src/schema/config.ts";

describe("GlobalConfig.renderer", () => {
  test("decodes an optional renderer field", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({ renderer: "json" });
    expect(decoded.renderer).toBe("json");
  });

  test("renderer is optional (undefined when absent)", () => {
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({});
    expect(decoded.renderer).toBeUndefined();
  });
});
