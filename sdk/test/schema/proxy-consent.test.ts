import { expect, test } from "bun:test";
import { JSONSchema, Schema } from "effect";

import { GlobalConfig, LandofileShape, ProxyConfig } from "@lando/sdk/schema";

test.each([
  {
    name: "ProxyConfig",
    decode: Schema.decodeUnknownEither(ProxyConfig, { onExcessProperty: "error" }),
    input: { defaultDomain: "lndo.site", autoApprove: true },
  },
  {
    name: "GlobalConfig.router",
    decode: Schema.decodeUnknownEither(GlobalConfig, { onExcessProperty: "error" }),
    input: { router: { autoApprove: true } },
  },
  {
    name: "LandofileShape.router",
    decode: Schema.decodeUnknownEither(LandofileShape, { onExcessProperty: "error" }),
    input: { name: "consent", router: { autoApprove: true } },
  },
])("rejects invocation consent in $name", ({ decode, input }) => {
  // Given: strict config decoding and an authored approval flag.
  // When
  const result = decode(input);
  // Then
  expect(result._tag).toBe("Left");
});

test("omits invocation consent from the published proxy configuration schema", () => {
  // Given / When
  const schema = JSONSchema.make(ProxyConfig);
  // Then
  expect(schema).toHaveProperty("properties.defaultDomain");
  expect(schema).not.toHaveProperty("properties.autoApprove");
});
