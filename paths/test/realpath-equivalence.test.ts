import { expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sameRealpath } from "../src/paths.ts";

test("treats identical strings as the same path", () => {
  expect(sameRealpath("/srv/apps/myapp", "/srv/apps/myapp")).toBe(true);
});

test("treats missing paths with harmless dot segments as the same path", () => {
  expect(sameRealpath("/srv/apps/./myapp", "/srv/apps/myapp")).toBe(true);
});

test("treats win32 drive-letter case as the same path", () => {
  expect(
    sameRealpath(
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app",
      "c:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app",
    ),
  ).toBe(true);
});

test("does not treat a distinct win32 short name as equal without realpath", () => {
  expect(
    sameRealpath(
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\embedded-app",
      "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\embedded-app",
    ),
  ).toBe(false);
});

test("treats a symlink and its realpath as the same path", async () => {
  const canonical = await realpath(await mkdtemp(join(tmpdir(), "lando-realpath-eq-")));
  const alias = `${canonical}-alias`;
  await symlink(canonical, alias);
  try {
    expect(sameRealpath(alias, canonical)).toBe(true);
    expect(sameRealpath(canonical, alias)).toBe(true);
  } finally {
    await rm(alias, { force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});

test("resolves non-lexical aliases through realpathSync.native", async () => {
  const canonical = await realpath(await mkdtemp(join(tmpdir(), "lando-realpath-eq-")));
  const alias = `${canonical}-alias`;
  await symlink(canonical, alias);
  const native = spyOn(realpathSync, "native");
  try {
    expect(sameRealpath(alias, canonical)).toBe(true);
    expect(native).toHaveBeenCalled();
  } finally {
    native.mockRestore();
    await rm(alias, { force: true });
    await rm(canonical, { recursive: true, force: true });
  }
});

test("rejects parent traversal through a symlink instead of collapsing it lexically", async () => {
  // Given: the alias points into a different parent directory.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-realpath-parent-")));
  await mkdir(join(root, "nested", "child"), { recursive: true });
  await symlink(join(root, "nested", "child"), join(root, "alias"), "junction");
  try {
    // When / Then: lexical collapse must not turn the alias parent into the app root.
    expect(sameRealpath(`${root}/alias/..`, root)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves distinct canonical names on case-sensitive Windows directories", () => {
  // Given: native resolution proves the differently cased directories are distinct.
  const native = spyOn(realpathSync, "native")
    .mockReturnValueOnce("C:\\apps\\Demo")
    .mockReturnValueOnce("C:\\apps\\demo");
  try {
    // When / Then: a Windows spelling alone does not prove case insensitivity.
    expect(sameRealpath("C:\\apps\\Demo", "C:\\apps\\demo")).toBe(false);
  } finally {
    native.mockRestore();
  }
});

test("rejects different spellings of a symlink loop", async () => {
  // Given: neither alias resolves to a filesystem path.
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-realpath-loop-")));
  await symlink(join(root, "second"), join(root, "first"));
  await symlink(join(root, "first"), join(root, "second"));
  try {
    // When / Then: unresolved aliases cannot establish ownership equivalence.
    expect(sameRealpath(join(root, "first"), join(root, "second"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
