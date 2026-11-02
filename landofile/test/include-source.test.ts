import { describe, expect, test } from "bun:test";
import { classify, parseGitInclude, parseNpmInclude } from "../src/include-source.ts";

describe("remote include source parsing", () => {
  for (const [source, cloneUrl, ref] of [
    ["git@github.com:acme/r.git", "git@github.com:acme/r.git", undefined],
    ["git@github.com:acme/r.git@v1", "git@github.com:acme/r.git", "v1"],
    ["https://user@host/r.git@v1", "https://user@host/r.git", "v1"],
    ["https://user@host/r.git", "https://user@host/r.git", undefined],
    ["git+https://host/r.git@v1", "https://host/r.git", "v1"],
    ["git+ssh://git@host/r.git@v1", "ssh://git@host/r.git", "v1"],
    ["ssh://git@host/r.git", "ssh://git@host/r.git", undefined],
  ] as const) {
    test(`parses ${source} without treating authority userinfo as a ref`, () => {
      // Given
      const entry = { source, path: "fragments\\php.yml" };
      // When
      const parsed = parseGitInclude(entry);
      // Then
      expect(classify(source)).toBe("git");
      expect(parsed).toMatchObject({ cloneUrl, path: "fragments/php.yml" });
      expect(parsed.ref).toBe(ref);
      expect(parsed.sourceId).toEndWith("/fragments/php.yml");
    });
  }
  for (const ref of [
    "-main",
    "/main",
    "+main",
    "a..b",
    "x:y",
    "@{",
    "foo.lock",
    ".main",
    "a/.b",
    "a//b",
    "a/",
    "@",
    "a b",
    "a\\b",
    "a~b",
    "a^b",
    "a?b",
    "a*b",
    "a[b",
    "a.",
  ]) {
    test(`rejects invalid ref ${ref}`, () => {
      // Given
      const entry = { source: "github:acme/r", path: "php.yml", version: ref };
      // When / Then
      expect(() => parseGitInclude(entry)).toThrow(
        expect.objectContaining({ _tag: "LandofileIncludeError", kind: "source-unresolved" }),
      );
    });
  }
  test("version overrides the source suffix and npm identity includes the normalized fragment path", () => {
    // Given
    const entry = { source: "npm:@acme/fragments@latest", path: "a\\web.yml", version: "next" };
    // When
    const parsed = parseNpmInclude(entry);
    // Then
    expect(parsed).toEqual({
      sourceId: "npm:@acme/fragments/a/web.yml",
      packageSpec: "@acme/fragments@next",
      packageName: "@acme/fragments",
      requestedVersion: "next",
      path: "a/web.yml",
    });
    expect(parseGitInclude({ source: "github:acme/r@v1", path: "php.yml", version: "v2" }).ref).toBe("v2");
  });
});
