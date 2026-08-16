import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { resolveLandofileIncludes } from "../src/includes.ts";

describe("Landofile runtime input failures", () => {
  test("fails in the typed channel when include resolution has no cache root", async () => {
    // Given / When
    const exit = await Effect.runPromiseExit(
      resolveLandofileIncludes({
        landofile: { includes: ["github:acme/fragments/fragment.yml"] },
        appRoot: "/tmp/lando-missing-runtime-input",
      }),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new TypeError("Expected include resolution to fail");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new TypeError("Expected a typed include failure");
    expect(failure.value._tag).toBe("LandofileIncludeError");
    if (failure.value._tag !== "LandofileIncludeError") {
      throw new TypeError(`Expected LandofileIncludeError, got ${failure.value._tag}`);
    }
    expect(failure.value.kind).toBe("source-unresolved");
  });
});
