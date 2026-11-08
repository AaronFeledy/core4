import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { withCwd } from "../_support/temp-cwd.ts";
import { expectHostDirectory, nativeHostDirectory } from "./fixtures/host-execution-process.ts";

describe("compiled host directory assertions without a supplied binary", () => {
  let root = "";
  let target = "";
  let other = "";
  let alias = "";
  const marker = "copied-marker";
  const output = (cwd: string, pwd = cwd) => `ACTUAL=${cwd}\nENV=<${pwd}>\nIDENTITY=${marker}\n`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lando-host-directory-"));
    target = join(root, "target");
    other = join(root, "other");
    alias = join(root, "alias");
    await mkdir(target);
    await mkdir(other);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    for (const dir of [root, target, other]) await writeFile(join(dir, ".host-marker"), marker);
  });

  afterAll(async () => {
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  test("accepts canonical ACTUAL for an independently entered aliased directory", async () => {
    const expected = await nativeHostDirectory(alias, root, process.env);
    await expectHostDirectory(output(await realpath(target)), expected);
  });

  test("accepts an alias ACTUAL only when it identifies the independently entered directory", async () => {
    const expected = await nativeHostDirectory(target, root, process.env);
    await expectHostDirectory(output(alias), expected);
  });

  test("rejects relative ACTUAL and synthesized PWD even when they identify the target", async () => {
    await withCwd(root, async () => {
      expect(await realpath("target")).toBe(await realpath(target));
      await expect(expectHostDirectory(output("target"), { cwd: target, marker })).rejects.toThrow();
    });
  });

  test.skipIf(process.platform !== "win32")(
    "rejects drive-relative ACTUAL and synthesized PWD even when they identify the target",
    async () => {
      await withCwd(root, async () => {
        const drive = parse(process.cwd()).root.slice(0, 2);
        expect(drive).toMatch(/^[a-z]:$/i);
        const actual = `${drive}target`;
        expect(await realpath(actual)).toBe(await realpath(target));
        await expect(expectHostDirectory(output(actual), { cwd: target, marker })).rejects.toThrow();
      });
    },
  );

  test.skipIf(process.platform !== "win32")(
    "rejects current-drive-rooted ACTUAL and synthesized PWD even when they identify the target",
    async () => {
      await withCwd(root, async () => {
        expect(parse(target).root).toMatch(/^[a-z]:[\\/]$/i);
        const actual = target.slice(2);
        expect(await realpath(actual)).toBe(await realpath(target));
        await expect(expectHostDirectory(output(actual), { cwd: target, marker })).rejects.toThrow();
      });
    },
  );

  test("rejects a different directory even when its marker is copied", async () => {
    const expected = await nativeHostDirectory(target, root, process.env);
    await expect(expectHostDirectory(output(other), expected)).rejects.toThrow();
  });

  test("rejects stale synthesized PWD even when ACTUAL and marker are correct", async () => {
    await expect(expectHostDirectory(output(target, other), { cwd: target, marker })).rejects.toThrow();
  });

  test("rejects an equivalent alias spelling for synthesized PWD", async () => {
    await expect(expectHostDirectory(output(target, alias), { cwd: target, marker })).rejects.toThrow();
  });

  test.each(["", "Authored-PwD", "C:\\Authored\\Mixed-Case"])(
    "preserves literal authored PWD %j",
    async (pwd) => {
      await expectHostDirectory(output(target, pwd), { cwd: target, marker }, pwd);
    },
  );

  test.each([
    ["authored-pwd", "Authored-PwD"],
    ["C:/Authored/Mixed-Case", "C:\\Authored\\Mixed-Case"],
    ["", "authored-pwd"],
    ["authored-pwd", ""],
  ])("rejects altered authored PWD %j (expected %j)", async (actualPwd, expectedPwd) => {
    await expect(
      expectHostDirectory(output(target, actualPwd), { cwd: target, marker }, expectedPwd),
    ).rejects.toThrow();
  });

  test.each(["ACTUAL", "ENV", "IDENTITY"])("rejects duplicate %s output", async (field) => {
    const text = output(target);
    const line = text.split("\n").find((value) => value.startsWith(`${field}=`));
    await expect(expectHostDirectory(`${text}${line}\n`, { cwd: target, marker })).rejects.toThrow();
  });

  test.each(["ACTUAL", "ENV", "IDENTITY"])("rejects echoed or missing %s output", async (field) => {
    const text = output(target)
      .split("\n")
      .map((line) => (line.startsWith(`${field}=`) ? `echo "${line}"` : line))
      .join("\n");
    await expect(expectHostDirectory(text, { cwd: target, marker })).rejects.toThrow();
  });

  test("rejects a wrong marker in the correct directory", async () => {
    await expect(
      expectHostDirectory(output(target), { cwd: target, marker: "different-marker" }),
    ).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "preserves OS symlink/.. traversal before canonical comparison",
    async () => {
      const child = join(target, "child");
      const link = join(root, "link");
      await mkdir(child);
      await symlink(child, link, "dir");
      const expected = await nativeHostDirectory(`${link}/..`, root, process.env);
      expect(expected.cwd).toBe(await realpath(target));
      await expectHostDirectory(output(target), expected);
      // Lexically erasing link/.. lands at root, which has the same marker.
      await expect(expectHostDirectory(output(root), expected)).rejects.toThrow();
    },
  );
});
