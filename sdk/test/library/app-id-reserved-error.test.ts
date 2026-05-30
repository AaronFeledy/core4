import { Schema } from "effect";

import { describe, expect, test } from "bun:test";

import { AppIdReservedError } from "@lando/sdk/errors";

describe("AppIdReservedError schema", () => {
  test("round-trips the reserved id through the encoded form", () => {
    const error = new AppIdReservedError({ reserved: "global" });
    const encoded = Schema.encodeSync(AppIdReservedError)(error);

    expect(encoded).toEqual({ _tag: "AppIdReservedError", reserved: "global" });

    const decoded = Schema.decodeUnknownSync(AppIdReservedError)(encoded);

    expect(decoded._tag).toBe("AppIdReservedError");
    expect(decoded.reserved).toBe("global");
    expect(decoded.suggested).toBeUndefined();
  });

  test("round-trips the optional suggestion", () => {
    const error = new AppIdReservedError({ reserved: "global", suggested: "my-app" });
    const encoded = Schema.encodeSync(AppIdReservedError)(error);

    expect(encoded.suggested).toBe("my-app");

    const decoded = Schema.decodeUnknownSync(AppIdReservedError)(encoded);

    expect(decoded.suggested).toBe("my-app");
  });
});
