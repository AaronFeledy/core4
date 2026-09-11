import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readAuxiliaryScaffoldContent } from "../../src/recipes/init-pipeline/files.ts";

const roots: string[] = [];

const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-files-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads and renders a relative template source from the recipe root", async () => {
  const sourceRoot = await temporary();
  await mkdir(join(sourceRoot, "templates"));
  await Bun.write(join(sourceRoot, "templates", "notice.tmpl"), "app={{ app.name }}\n");

  const content = await readAuxiliaryScaffoldContent({
    file: { src: "templates/notice.tmpl", dest: "notice.txt", template: true },
    appName: "relative-app",
    sourceRoot,
  });

  expect(content).toBe("app=relative-app\n");
});

test("rejects a relative auxiliary source that escapes the recipe root", async () => {
  const sourceRoot = await temporary();
  const outside = join(await temporary(), "outside.txt");
  await Bun.write(outside, "outside");

  expect(
    readAuxiliaryScaffoldContent({
      file: { src: relative(sourceRoot, outside), dest: "outside.txt" },
      appName: "confined",
      sourceRoot,
    }),
  ).rejects.toThrow("inside the recipe root");
});

test("rejects an absolute auxiliary source outside the recipe root", async () => {
  const sourceRoot = await temporary();
  const outside = join(await temporary(), "outside.txt");
  await Bun.write(outside, "outside");

  expect(
    readAuxiliaryScaffoldContent({
      file: { src: outside, dest: "outside.txt" },
      appName: "confined",
      sourceRoot,
    }),
  ).rejects.toThrow("inside the recipe root");
});

test("rejects a disk auxiliary source without a recipe root or content source", async () => {
  const source = join(await temporary(), "source.txt");
  await Bun.write(source, "source");

  expect(
    readAuxiliaryScaffoldContent({
      file: { src: source, dest: "source.txt" },
      appName: "rootless",
    }),
  ).rejects.toThrow("recipe root or content source");
});

test("does not follow a relative auxiliary source symlink", async () => {
  const sourceRoot = await temporary();
  await Bun.write(join(sourceRoot, "target.txt"), "target");
  await symlink("target.txt", join(sourceRoot, "link.txt"));

  expect(
    readAuxiliaryScaffoldContent({
      file: { src: "link.txt", dest: "link.txt" },
      appName: "no-follow",
      sourceRoot,
    }),
  ).rejects.toThrow("symlink");
});
