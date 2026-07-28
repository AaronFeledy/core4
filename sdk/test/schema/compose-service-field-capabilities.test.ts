import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ComposeServiceFieldCapabilities, ComposeServiceFieldKey } from "@lando/sdk/schema";

describe("ComposeServiceFieldKey", () => {
  test("publishes the complete service-level Compose field set", () => {
    expect(ComposeServiceFieldKey.literals).toEqual(["networks", "configs", "secrets", "profiles", "labels"]);
  });
});

describe("ComposeServiceFieldCapabilities", () => {
  test("decodes supported service-level Compose fields", () => {
    const decoded = Schema.decodeUnknownSync(ComposeServiceFieldCapabilities)({
      supported: ["networks", "configs", "secrets", "profiles", "labels"],
    });

    expect(decoded).toEqual({ supported: ["networks", "configs", "secrets", "profiles", "labels"] });
  });

  test("rejects fields outside the published literal union", () => {
    const result = Schema.decodeUnknownEither(ComposeServiceFieldCapabilities)({
      supported: ["volumes"],
    });

    expect(Either.isLeft(result)).toBe(true);
  });
});
