import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginImplementationIdentity } from "../../src/plugins/implementation-identity.ts";
import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader.ts";
import { importPluginModule, loadPluginModules } from "../../src/plugins/module-cache.ts";

const withPackage = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-module-cache-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        landoPlugin: { name: "@example/reload", version: "1.0.0", api: 4, entry: "index.ts" },
      }),
    );
    await writeFile(join(root, "index.ts"), 'export { value } from "./child.ts";');
    await writeFile(join(root, "child.ts"), 'export const value = "before";');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each(["index.ts", "child.ts"])("reloads edited %s including transitive modules", (file) =>
  withPackage(async (root) => {
    const first = await loadInstalledPlugin(root);
    const identity = await pluginImplementationIdentity(root);
    await writeFile(join(root, file), 'export const value = "after";');
    const second = await loadInstalledPlugin(root);
    expect(first.module?.value).toBe("before");
    expect(second.module?.value).toBe("after");
    expect((await pluginImplementationIdentity(root)).identity).not.toBe(identity.identity);
  }),
);

test("a syntax error is tagged and its next fixed import recovers", () =>
  withPackage(async (root) => {
    await loadInstalledPlugin(root);
    await writeFile(join(root, "child.ts"), "export const value = ;");
    await expect(loadInstalledPlugin(root)).rejects.toMatchObject({ _tag: "PluginLoadError" });
    await writeFile(join(root, "child.ts"), 'export const value = "fixed";');
    expect((await loadInstalledPlugin(root)).module?.value).toBe("fixed");
  }));

test("entryless packages evict their lazily loaded contributions", () =>
  withPackage(async (root) => {
    const manifest = { name: "@example/entryless", version: "1.0.0", api: 4 };
    await writeFile(join(root, "package.json"), JSON.stringify({ landoPlugin: manifest }));
    const installed = await loadInstalledPlugin(root);
    const first = await importPluginModule(join(root, "child.ts"));
    await writeFile(join(root, "child.ts"), 'export const value = "entryless-after";');
    await loadInstalledPlugin(root);
    const second = await importPluginModule(join(root, "child.ts"));
    expect(installed.module).toBeUndefined();
    expect(first).toMatchObject({ value: "before" });
    expect(second).toMatchObject({ value: "entryless-after" });
  }));

test("import receipts report identity churn instead of blessing different bytes", () =>
  withPackage(async (root) => {
    const before = await pluginImplementationIdentity(root);
    const receipt = await loadPluginModules(root, async () => {
      await writeFile(join(root, "child.ts"), 'export const value = "during-import";');
      return importPluginModule(join(root, "index.ts"));
    });
    expect(receipt.stable).toBe(false);
    expect(receipt.implementation.identity).toBe(before.identity);
  }));

test("dependency manifest changes reload private dependencies and preserve host peers", () =>
  withPackage(async (root) => {
    const dependency = join(root, "node_modules", "private-dependency");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "private-dependency", main: "index.js", version: "1" }),
    );
    await writeFile(join(dependency, "index.js"), 'export const value = "dependency-before";');
    await writeFile(
      join(root, "index.ts"),
      'export { value } from "private-dependency"; export { Effect } from "effect";',
    );
    const first = await loadInstalledPlugin(root);
    await writeFile(join(dependency, "index.js"), 'export const value = "dependency-after";');
    await writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "private-dependency", main: "index.js", version: "2" }),
    );
    const second = await loadInstalledPlugin(root);
    expect(first.module?.value).toBe("dependency-before");
    expect(second.module?.value).toBe("dependency-after");
    expect(second.module?.Effect).toBe(first.module?.Effect);
  }));

test("identity ignores hidden directories and dependency bodies but observes restored mtimes and symlink targets", () =>
  withPackage(async (root) => {
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, ".hidden", "ignored.ts"), "first");
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(root, "node_modules", "dependency", "package.json"), '{"version":"1"}');
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "first");
    await writeFile(join(root, ".env"), "VALUE=first");
    await symlink("child.ts", join(root, "link.ts"));
    const first = await pluginImplementationIdentity(root);
    await writeFile(join(root, ".hidden", "ignored.ts"), "second");
    await writeFile(join(root, "node_modules", "dependency", "index.js"), "second");
    expect(await pluginImplementationIdentity(root)).toEqual(first);
    await writeFile(join(root, ".env"), "VALUE=other");
    const dotfile = await pluginImplementationIdentity(root);
    expect(dotfile.identity).not.toBe(first.identity);
    await writeFile(join(root, "child.ts"), 'export const value = "after";');
    await utimes(join(root, "child.ts"), 0, 0);
    expect((await pluginImplementationIdentity(root)).identity).not.toBe(dotfile.identity);
  }));
