import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

const decodeDefault = Schema.decodeUnknownSync(GlobalConfig);
const decodeStrict = Schema.decodeUnknownSync(GlobalConfig, { onExcessProperty: "error" });

describe("GlobalConfig.proxy.defaultDomain", () => {
  test("decodes an explicit defaultDomain", () => {
    // Given / When
    const decoded = decodeDefault({ proxy: { defaultDomain: "example.test" } });

    // Then
    expect(decoded.proxy?.defaultDomain).toBe("example.test");
  });

  test("defaults defaultDomain when proxy is present without the key", () => {
    // Given / When
    const decoded = decodeDefault({ proxy: {} });

    // Then
    expect(decoded.proxy?.defaultDomain).toBe("lndo.site");
  });

  test("leaves proxy undefined when the key is omitted", () => {
    // Given / When
    const decoded = decodeDefault({});

    // Then
    expect(decoded.proxy).toBeUndefined();
  });

  test("decode(decode(x)) round-trips under default and onExcessProperty error", () => {
    const inputs = [{}, { proxy: {} }, { proxy: { defaultDomain: "example.test" } }] as const;

    for (const input of inputs) {
      for (const decode of [decodeDefault, decodeStrict]) {
        // Given
        const once = decode(input);
        // When — second pass must accept the first decode's canonical output
        const twice = decode(once);
        // Then
        expect(twice.proxy?.defaultDomain).toBe(once.proxy?.defaultDomain);
        expect(twice.proxy).toEqual(once.proxy);
      }
    }
  });
});
