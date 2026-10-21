import { describe, expect, test } from "bun:test";
import { encodeLandofileSourceValue, override, reset } from "@lando/sdk/landofile";
import { LandofileSourceValue } from "@lando/sdk/schema";
import { Schema } from "effect";

describe("authored source transport", () => {
  test.each([null, false, 1.5, "text", [1, null], { "arbitrary key: []": [false] }])(
    "retains JSON value %j",
    (value) => {
      const encoded = Schema.decodeUnknownSync(LandofileSourceValue)(encodeLandofileSourceValue(value));
      expect(encoded).toEqual(value);
    },
  );
  test.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, Symbol("unsupported")])(
    "rejects non-JSON source %s",
    (value) => {
      expect(Schema.is(LandofileSourceValue)(encodeLandofileSourceValue(value))).toBe(false);
    },
  );
  test("distinguishes directives from literal transport collisions", () => {
    const value = {
      reset: reset(),
      override: override([reset(), "authored"]),
      literal: { _tag: "LandofileReset" },
      nested: { _tag: "LandofileLiteral", value: { _tag: "LandofileOverride", value: 3 } },
    };
    const encoded = Schema.decodeUnknownSync(LandofileSourceValue)(encodeLandofileSourceValue(value));
    expect(encoded).toEqual({
      reset: { _tag: "LandofileReset" },
      override: { _tag: "LandofileOverride", value: [{ _tag: "LandofileReset" }, "authored"] },
      literal: { _tag: "LandofileLiteral", value: { _tag: "LandofileReset" } },
      nested: {
        _tag: "LandofileLiteral",
        value: {
          _tag: "LandofileLiteral",
          value: { _tag: "LandofileLiteral", value: { _tag: "LandofileOverride", value: 3 } },
        },
      },
    });
  });
});
