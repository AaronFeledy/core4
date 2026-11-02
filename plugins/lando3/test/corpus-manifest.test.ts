import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { corpusRoot } from "./fixtures/corpus-input.ts";
import manifest from "./fixtures/corpus/manifest.json";

test.each(manifest.repositories)("preserves upstream bytes for $repo", async (repository) => {
  // Given: pinned upstream paths and hashes, independent of translation.
  expect(repository.license).toBe("MIT");
  expect(repository.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(repository.url).toBe(`https://github.com/lando/${repository.repo}`);
  // When: read the actual vendored bytes, without YAML parsing or normalization.
  for (const file of repository.files) {
    const bytes = await Bun.file(join(corpusRoot, repository.repo, file.path)).bytes();
    // Then
    expect(bytes.length, file.path).toBe(file.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), file.path).toBe(file.sha256);
  }
});

test("covers every vendored Landofile exactly once in a directory document set", () => {
  // Given
  const files = manifest.repositories.flatMap(({ repo, files }) =>
    files.map(({ path }) => `${repo}/${path}`),
  );
  // When
  const disk = [...new Bun.Glob("**/.lando{,.*}.yml").scanSync({ cwd: corpusRoot, dot: true })];
  const members = manifest.documentSets.flatMap(({ files }) => files);
  // Then
  expect(disk.sort()).toEqual([...files].sort());
  expect([...members].sort()).toEqual([...files].sort());
  expect(new Set(members).size).toBe(members.length);
  for (const set of manifest.documentSets) {
    expect(set.files.length).toBeGreaterThan(0);
    for (const file of set.files) expect(dirname(file)).toBe(set.id.replace(/\/\.$/, ""));
  }
});
