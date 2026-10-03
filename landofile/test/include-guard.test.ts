import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUnderRoot } from "../src/include-guard.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lando-include-guard-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

for (const path of ["..local/missing.yml", "."]) {
  test(`allows include path ${path}`, async () => {
    // Given a contained missing path or root equality
    const candidate = join(root, path);
    // When the include guard resolves it
    const result = await assertUnderRoot(root, candidate, path);
    // Then its equality and missing-path fallback remain unchanged
    expect(result).toBe(candidate);
  });
}

for (const path of ["..", "../outside.yml"]) {
  test(`preserves include domain error for ${path}`, async () => {
    // Given a true traversal outside the root
    const candidate = join(root, path);
    // When the include guard resolves it
    const result = await assertUnderRoot(root, candidate, path).then(
      () => "accepted",
      (error: unknown) => error,
    );
    // Then callers still receive the intentional LandofileIncludeError
    expect(result).toMatchObject({ _tag: "LandofileIncludeError", kind: "outside-root", source: path });
  });
}

test("rejects an existing symlink escape", async () => {
  // Given a symlink that points above the root
  await symlink(join(root, ".."), join(root, "escape"), "junction");
  // When the existing linked path is guarded
  const result = await assertUnderRoot(root, join(root, "escape"), "escape").then(
    () => "accepted",
    (error: unknown) => error,
  );
  // Then realpath containment preserves the include failure
  expect(result).toMatchObject({ _tag: "LandofileIncludeError", kind: "outside-root" });
});

test("retains a single realpath fallback for missing symlink descendants", async () => {
  // Given a missing path below a symlink that would resolve outside if it existed
  await symlink(join(root, ".."), join(root, "escape"), "junction");
  const candidate = join(root, "escape", "missing-fragment.yml");
  // When realpath fails for the full include path
  const result = await assertUnderRoot(root, candidate, "escape/missing-fragment.yml");
  // Then this guard keeps its existing lexical fallback, not ancestor traversal
  expect(result).toBe(candidate);
});
