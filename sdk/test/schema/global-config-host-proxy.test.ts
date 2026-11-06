import { describe, expect, test } from "bun:test";
import { GlobalConfig, GlobalConfigView } from "@lando/sdk/schema";
import { Schema } from "effect";

describe("GlobalConfig.hostProxy", () => {
  test.each([{}, { allowedSchemes: [] }, { allowedSchemes: ["figma", "Slack", "a+b.c-d0"] }])(
    "decodes valid host-proxy policy %j",
    (hostProxy) => {
      // Given
      const input = { hostProxy };
      // When
      const decoded = Schema.decodeUnknownSync(GlobalConfig)(input);
      // Then
      expect(decoded.hostProxy).toEqual(hostProxy);
    },
  );

  test.each(["", "figma:", "1slack", "sl ack", "sl_ack", "https://example.com", "slack\n"])(
    "rejects invalid scheme token %j",
    (scheme) => {
      // Given
      const input = { hostProxy: { allowedSchemes: [scheme] } };
      // When
      const decoded = Schema.decodeUnknownResult(GlobalConfig)(input);
      // Then
      expect(decoded._tag).toBe("Failure");
    },
  );

  test.each(["file", "FILE", "FiLe"])("rejects forbidden scheme %j", (scheme) => {
    // Given
    const input = { hostProxy: { allowedSchemes: [scheme] } };
    // When
    const decoded = Schema.decodeUnknownResult(GlobalConfig)(input);
    // Then
    expect(decoded._tag).toBe("Failure");
  });

  test("preserves allowed schemes through an encoded round trip", () => {
    // Given
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      hostProxy: { allowedSchemes: ["figma", "Slack"] },
    });
    // When
    const roundTrip = Schema.decodeUnknownSync(GlobalConfig)(Schema.encodeSync(GlobalConfig)(decoded));
    // Then
    expect(roundTrip).toEqual(decoded);
  });

  test("exposes host-proxy policy in the public config view", () => {
    // Given
    const decoded = Schema.decodeUnknownSync(GlobalConfig)({
      hostProxy: { allowedSchemes: ["figma", "slack"] },
    });
    // When
    const view = Schema.encodeSync(GlobalConfigView)(decoded);
    // Then
    expect(view.hostProxy).toEqual({ allowedSchemes: ["figma", "slack"] });
  });
});
