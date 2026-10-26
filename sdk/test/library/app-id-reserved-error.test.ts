import { Schema } from "effect";

import { describe, expect, test } from "bun:test";

import { AppIdReservedError } from "@lando/sdk/errors";

describe("AppIdReservedError schema", () => {
  test("round-trips the reserved id through the encoded form", () => {
    const error = new AppIdReservedError({ reserved: "global" });
    const encoded = Schema.encodeSync(AppIdReservedError)(error);

    expect(encoded._tag).toBe("AppIdReservedError");
    expect(encoded.reserved).toBe("global");
    expect(encoded.remediation.trim().length).toBeGreaterThan(0);

    const decoded = Schema.decodeUnknownSync(AppIdReservedError)(encoded);

    expect(decoded._tag).toBe("AppIdReservedError");
    expect(decoded.reserved).toBe("global");
    expect(decoded.suggested).toBeUndefined();
    expect(decoded.remediation).toBe(encoded.remediation);
  });

  test("round-trips the optional suggestion", () => {
    const error = new AppIdReservedError({ reserved: "global", suggested: "my-app" });
    const encoded = Schema.encodeSync(AppIdReservedError)(error);

    expect(encoded.suggested).toBe("my-app");

    const decoded = Schema.decodeUnknownSync(AppIdReservedError)(encoded);

    expect(decoded.suggested).toBe("my-app");
  });
});
