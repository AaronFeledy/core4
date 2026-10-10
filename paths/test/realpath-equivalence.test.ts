import { expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sameRealpath } from "../src/paths.ts";

test("treats identical strings as the same path", () => {
  expect(sameRealpath("/srv/apps/myapp", "/srv/apps/myapp")).toBe(true);
});

test("treats lexically normalized parent segments as the same path without realpath", () => {
  expect(sameRealpath("/srv/apps/foo/../myapp", "/srv/apps/myapp")).toBe(true);
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
