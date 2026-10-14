import { describe, expect, test } from "bun:test";
import { override, parseLandofile, reset } from "@lando/sdk/landofile";
import { Effect } from "effect";

describe("directives in YAML merge sources", () => {
  test.each([
    { source: "target:\n  <<: !override\n    image: nginx\n", line: 2 },
    { source: "base: &base !override\n  image: nginx\ntarget:\n  <<: *base\n", line: 4 },
    { source: "target:\n  <<: !reset\n", line: 2 },
    { source: "base: &base !reset\ntarget:\n  <<: [*base]\n", line: 3 },
  ])("rejects a directive merge source at line $line", ({ source, line }) => {
    // Given a merge source that is an operation, not a mapping.
    // When the authored YAML is parsed.
    const result = Effect.runSync(
      Effect.result(parseLandofile({ file: ".lando.yml", cwd: "/app", content: source })),
    );
    // Then the merge key fails closed with member-level remediation.
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("Expected a directive merge-source failure");
    expect(result.failure).toMatchObject({ _tag: "LandofileParseError", line, column: 6 });
    expect(result.failure.message).toContain("<<");
    expect(result.failure.remediation).toMatch(/target member/i);
  });

  test("preserves member directives when an anchored mapping is merged", () => {
    // Given an ordinary mapping whose members carry operations.
    const content = "base: &base\n  image: !override nginx\n  environment: !reset\ntarget:\n  <<: *base\n";
    // When the mapping is used as a merge source.
    const result = Effect.runSync(parseLandofile({ file: ".lando.yml", cwd: "/app", content }));
    // Then the target retains the member operations.
    expect(result.target).toEqual({ image: override("nginx"), environment: reset() });
  });
});
