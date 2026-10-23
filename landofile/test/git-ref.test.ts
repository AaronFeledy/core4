import { expect, test } from "bun:test";
import { gitCloneUrl, isGitSource, isLiteralGitRef, splitSourceRef } from "@lando/landofile/git-ref";

for (const [raw, value, ref] of [
  ["git@host:repo@main", "git@host:repo", "main"],
  ["git@host:repo", "git@host:repo", undefined],
  ["https://user@host/repo@v1", "https://user@host/repo", "v1"],
  ["ssh://git@host", "ssh://git@host", undefined],
  ["@scope/package@1.0.0", "@scope/package", "1.0.0"],
  ["github:owner/repo@feature/topic", "github:owner/repo", "feature/topic"],
] as const) {
  test(`splits ${raw} without confusing authority credentials`, () => {
    // Given / When
    const parsed = splitSourceRef(raw);
    // Then
    expect(parsed.value).toBe(value);
    expect(parsed.ref).toBe(ref);
  });
}
for (const ref of ["main", "refs/tags/v1", "a".repeat(40), "feature/topic"]) {
  test(`accepts literal ref ${ref}`, () => {
    // Given / When / Then
    expect(isLiteralGitRef(ref)).toBe(true);
  });
}
for (const ref of ["--upload-pack=evil", "+main", "a..b", "a.lock", "@{x}", "a b", ".hidden", "a/"]) {
  test(`rejects unsafe ref ${ref}`, () => {
    // Given / When / Then
    expect(isLiteralGitRef(ref)).toBe(false);
  });
}
for (const [source, url] of [
  ["github:owner/repo", "https://github.com/owner/repo.git"],
  ["git+ssh://git@host/repo", "ssh://git@host/repo"],
  ["git+https://host/repo", "https://host/repo"],
  ["git@host:repo", "git@host:repo"],
] as const) {
  test(`classifies and converts ${source}`, () => {
    // Given / When / Then
    expect(isGitSource(source)).toBe(true);
    expect(gitCloneUrl(source)).toBe(url);
    expect(isGitSource("./local.yml")).toBe(false);
  });
}
