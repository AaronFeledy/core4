import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoadError } from "@lando/sdk/errors";
import { pinPluginPackageRoot, resolvePluginModulePath } from "../../src/plugins/plugin-module-path.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lando-module-path-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolveModule = async (path: string) =>
  resolvePluginModulePath(await pinPluginPackageRoot(root), "example", path);

test("accepts an existing plugin module beneath ..local", async () => {
  // Given a module with a dot-prefixed directory name, not a parent segment
  await mkdir(join(root, "..local"));
  await writeFile(join(root, "..local", "index.ts"), "export const plugin = {};\n");
  // When the plugin loader resolves that authored path
  const result = await resolveModule("./..local/index.ts");
  // Then both lexical and real containment accept it
  expect(result).toBe(join(root, "..local", "index.ts"));
});

test("allows a missing ..local module through the existing single-realpath fallback", async () => {
  // Given a missing module under the package root
  const path = "./..local/missing/index.ts";
  // When the plugin loader resolves it
  const result = await resolveModule(path);
  // Then resolution keeps the contained lexical path
  expect(result).toBe(join(root, "..local", "missing", "index.ts"));
});

for (const path of ["..", "../outside/index.ts"]) {
  test(`rejects true traversal ${path}`, async () => {
    // Given a module path outside the package
    // When the plugin loader resolves it
    const result = resolveModule(path);
    // Then its domain failure is preserved
    expect(await result.catch((error: unknown) => error)).toBeInstanceOf(PluginLoadError);
  });
}

test("allows package-root equality", async () => {
  // Given an authored path naming the package root
  // When resolution runs
  const result = await resolveModule(".");
  // Then this consumer retains equality allowance
  expect(result).toBe(root);
});

test("rejects a sibling prefix", async () => {
  // Given an absolute sibling with the same string prefix
  const path = `${root}-sibling/index.ts`;
  // When the module is resolved
  const result = resolveModule(path);
  // Then string-prefix overlap grants no containment
  expect(await result.catch((error: unknown) => error)).toBeInstanceOf(PluginLoadError);
});

test("rejects a module symlink escaping the package", async () => {
  // Given a contained symlink pointing at the parent outside the package
  await symlink(join(root, ".."), join(root, "link"), "junction");
  // When an existing linked module path is resolved
  const result = resolveModule("./link");
  // Then realpath containment preserves the plugin failure
  expect(await result.catch((error: unknown) => error)).toBeInstanceOf(PluginLoadError);
});
