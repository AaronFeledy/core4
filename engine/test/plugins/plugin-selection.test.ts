import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader.ts";
import { type PluginSelectionPolicy, resolvePluginSelection } from "../../src/plugins/selection.ts";

const policy: PluginSelectionPolicy = {
  discovery: { bundled: false, system: false, user: true, app: true, disable: [] },
  manifests: [],
  externalImports: true,
};

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-plugin-selection-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const installPlugin = async (pluginsDir: string, name: string, entrySource: string) => {
  const path = join(pluginsDir, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ landoPlugin: { name, version: "1.0.0", api: 4, entry: "./index.ts" } }),
  );
  await writeFile(join(path, "index.ts"), entrySource);
  await writeFile(
    join(pluginsDir, "registry.json"),
    JSON.stringify({ [name]: { name, version: "1.0.0", path } }),
  );
  return path;
};

const select = (root: string, appRoot: string) =>
  Effect.runPromise(
    resolvePluginSelection({
      policy,
      roots: { systemPluginsDir: join(root, "system"), pluginsDir: join(root, "user") },
      modules: [],
      appRoot,
    }),
  );

test("the selection fingerprint is stable, sees a newly created app registry, and sees entry edits", () =>
  withRoot(async (root) => {
    // Given an app with no app-local plugin registry yet
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, ".lando.yml"), "name: selection\n");
    const empty = await select(root, app);

    // When the same inputs are read again, a registry is created, and its entry is edited
    const repeat = await select(root, app);
    await installPlugin(join(app, ".lando/plugins"), "@example/selection", "export const v = 1;\n");
    const installed = await select(root, app);
    await writeFile(join(app, ".lando/plugins/@example/selection/index.ts"), "export const v = 2;\n");
    const edited = await select(root, app);

    // Then only changed inputs change the fingerprint, and the new selection names the app plugin
    expect(repeat.fingerprint).toBe(empty.fingerprint);
    expect(empty.resolution.plugins).toEqual([]);
    expect(installed.fingerprint).not.toBe(empty.fingerprint);
    expect(
      installed.resolution.plugins.map((plugin) => [plugin.source, String(plugin.manifest.name)]),
    ).toEqual([["app", "@example/selection"]]);
    expect(edited.fingerprint).not.toBe(installed.fingerprint);
  }));

test("an imported entry reloads after an edit", () =>
  withRoot(async (root) => {
    // Given an app plugin whose entry this process imported
    const app = join(root, "app");
    await mkdir(app);
    await writeFile(join(app, ".lando.yml"), "name: stale\n");
    const path = await installPlugin(
      join(app, ".lando/plugins"),
      "@example/stale-entry",
      "export const loaded = 'first';\n",
    );
    await loadInstalledPlugin(path);

    // When the entry file changes on disk at the same path
    await writeFile(join(path, "index.ts"), "export const loaded = 'second';\n");
    const selection = await select(root, app);
    const load = await loadInstalledPlugin(path);

    // Then selection succeeds and loading evaluates the edited module
    expect(selection.resolution.plugins).toHaveLength(1);
    expect(load.module?.loaded).toBe("second");
  }));

test("an unreadable plugin entry fails loading with a tagged error naming the plugin and entry", () =>
  withRoot(async (root) => {
    // Given a plugin whose entry path resolves inside the package but cannot be read as a file
    const path = await installPlugin(join(root, "plugins"), "@example/unreadable", "");
    await rm(join(path, "index.ts"));
    await mkdir(join(path, "index.ts"));

    // When the plugin is loaded
    const failure = await loadInstalledPlugin(path).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Then the read failure is the tagged plugin load error, not a raw filesystem error
    expect(failure).toMatchObject({
      _tag: "PluginLoadError",
      pluginName: "@example/unreadable",
      remediation: expect.stringContaining(join(path, "index.ts")),
    });
  }));
