import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { GlobalConfig } from "@lando/sdk/schema";

import { readProxyDefaultDomain } from "../../src/config/proxy-default-domain.ts";
import { DEFAULT_PROXY_DOMAIN } from "../../src/planner/naming.ts";

const decodeGlobal = Schema.decodeUnknownSync(GlobalConfig);

describe("readProxyDefaultDomain", () => {
  test("returns lndo.site when global config has no proxy block", () => {
    // Given
    const config = decodeGlobal({});
    // When / Then
    expect(readProxyDefaultDomain(config)).toBe("lndo.site");
    expect(readProxyDefaultDomain(config)).toBe(DEFAULT_PROXY_DOMAIN);
  });

  test("returns lndo.site when proxy is present without defaultDomain", () => {
    // Given
    const config = decodeGlobal({ proxy: {} });
    // When / Then
    expect(readProxyDefaultDomain(config)).toBe(DEFAULT_PROXY_DOMAIN);
  });

  test("passes through an explicit defaultDomain", () => {
    // Given
    const config = decodeGlobal({ proxy: { defaultDomain: "example.test" } });
    // When / Then
    expect(readProxyDefaultDomain(config)).toBe("example.test");
  });
});
