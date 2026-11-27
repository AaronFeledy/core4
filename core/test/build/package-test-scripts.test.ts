import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

const workspaceDirectories = async (): Promise<ReadonlyArray<string>> => {
  const manifest: { readonly workspaces: { readonly packages: ReadonlyArray<string> } } = await Bun.file(
    resolve(repoRoot, "package.json"),
  ).json();
  const directories: string[] = [];
  for (const pattern of manifest.workspaces.packages) {
    for await (const match of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: repoRoot })) {
      directories.push(match.slice(0, -"/package.json".length));
    }
  }
  return directories.sort();
};

test("every workspace package test script runs through the repo root bunfig", async () => {
  // Given: `bun test` started inside a package directory skips the root bunfig.toml, so it
  // loses the preserved-symlink refusal (#2541), the per-process root isolation preload, and
  // the generated-module check, and can load each workspace package twice.
  const scripts: Record<string, string> = {};
  for (const directory of await workspaceDirectories()) {
    const manifest: { readonly scripts?: Readonly<Record<string, string>> } = await Bun.file(
      resolve(repoRoot, directory, "package.json"),
    ).json();
    const script = manifest.scripts?.test;
    if (script !== undefined) scripts[directory] = script;
  }

  // When
  const expected = Object.fromEntries(
    Object.keys(scripts).map((directory) => [
      directory,
      `bun --cwd=${relative(resolve(repoRoot, directory), repoRoot)} test ./${directory}/test`,
    ]),
  );

  // Then
  expect(Object.keys(scripts)).toContain("engine");
  expect(scripts).toEqual(expected);
});
