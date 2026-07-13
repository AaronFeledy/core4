import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { LandofileVersionConstraintError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";

describe("Landofile version-constraint schema", () => {
  test("rejects malformed lando ranges at the boundary", () => {
    const decoded = Schema.decodeUnknownEither(LandofileShape)({ name: "bad", lando: "not-semver" });

    expect(decoded._tag).toBe("Left");
  });
});

describe("LandofileVersionConstraintError", () => {
  test("rejects provenance whose layer and order do not match", () => {
    const decoded = Schema.decodeUnknownEither(LandofileVersionConstraintError)({
      _tag: "LandofileVersionConstraintError",
      message: "version mismatch",
      constraints: [{ range: ">=5", source: ".lando.base.yml", layer: "base", order: 1 }],
      runningVersion: "4.2.0",
      remediation: "Update Lando.",
    });

    expect(decoded._tag).toBe("Left");
  });
});
