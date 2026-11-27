import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { makeLandoPaths } from "@lando/paths";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { Effect, Layer, Result, Schema } from "effect";

import {
  type LoadedPluginContribution,
  PluginContributionGraph,
  mergeLoadedPluginSources,
  pluginCommandCandidates,
} from "../../src/plugins/contribution-graph.ts";
import { PluginManifestResolution, resolvePluginManifests } from "../../src/plugins/manifest-resolution.ts";
import { systemPluginsFromModules } from "../../src/plugins/plugin-discovery.ts";

const loaded = (source: LoadedPluginContribution["source"], version: string): LoadedPluginContribution => {
  const manifest = Schema.decodeSync(PluginManifest)({
    name: "@example/shared",
    version,
    api: 4,
  });
  return { source, manifest, entry: definePlugin({ name: manifest.name, manifest }) };
};

describe("plugin contribution source merge", () => {
  test("builds app contributions when the app has conflicting Landofile forms", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-graph-dual-"));
    try {
      await writeFile(join(root, ".lando.yml"), "name: graph\n");
      await writeFile(join(root, ".lando.ts"), 'export default { name: "graph" };\n');
      const pluginsRoot = join(root, ".lando", "plugins");
      const pluginPath = join(pluginsRoot, "example");
      const manifest = { name: "@example/app-local", version: "1.0.0", api: 4 };
      await mkdir(pluginPath, { recursive: true });
      await writeFile(join(pluginPath, "package.json"), JSON.stringify({ landoPlugin: manifest }));
      await writeFile(
        join(pluginsRoot, "registry.json"),
        JSON.stringify({
          [manifest.name]: { name: manifest.name, version: manifest.version, path: pluginPath },
        }),
      );
      const graphLayer = PluginContributionGraph.layer<never>(
        {
          cwd: root,
          layers: [],
          manifests: [],
          externalImports: true,
          discovery: { bundled: false, system: false, user: false, app: true, disable: [] },
        },
        [],
      ).pipe(Layer.provide(Layer.succeed(PathsService, makeLandoPaths())));
      // When
      const plugins = await Effect.runPromise(
        Effect.scoped(
          Effect.map(PluginContributionGraph, (graph) => graph.plugins).pipe(Effect.provide(graphLayer)),
        ),
      );
      // Then
      expect(plugins).toMatchObject([{ source: "app", manifest }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a rebound plugin package link even when the manifest and registry path match", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-graph-rebound-"));
    try {
      const manifest = { name: "@example/linked", version: "1.0.0", api: 4 };
      const first = join(root, "first");
      const second = join(root, "second");
      const path = join(root, "plugin-link");
      for (const target of [first, second]) {
        await mkdir(target);
        await writeFile(join(target, "package.json"), JSON.stringify({ landoPlugin: manifest }));
      }
      await symlink(first, path, "junction");
      const cwd = join(root, "invocation");
      const source = join(root, "source");
      for (const app of [cwd, source]) {
        const registry = join(app, ".lando", "plugins");
        await mkdir(registry, { recursive: true });
        await writeFile(join(app, ".lando.yml"), "name: comparison\n");
        await writeFile(
          join(registry, "registry.json"),
          JSON.stringify({ [manifest.name]: { name: manifest.name, version: manifest.version, path } }),
        );
      }
      const layer = PluginContributionGraph.layer<never>(
        {
          cwd,
          layers: [],
          manifests: [],
          externalImports: true,
          discovery: { bundled: false, system: false, user: false, app: true, disable: [] },
        },
        [],
      ).pipe(Layer.provide(Layer.succeed(PathsService, makeLandoPaths())));
      const matches = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const graph = yield* PluginContributionGraph;
            if (graph.matchesAppPluginSelection === undefined)
              throw new Error("Expected app plugin discovery.");
            expect(yield* graph.matchesAppPluginSelection(source)).toBe(true);
            yield* Effect.promise(async () => {
              await unlink(path);
              await symlink(second, path, "junction");
            });
            return yield* graph.matchesAppPluginSelection(source);
          }).pipe(Effect.provide(layer)),
        ),
      );
      expect(matches).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("imports the pinned linked package with absolute module paths under its authored alias", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "lando-graph-linked-")));
    try {
      const first = join(root, "first");
      const replacement = join(root, "replacement");
      const path = join(root, "plugin-link");
      const registry = join(root, ".lando", "plugins");
      const manifest = {
        name: "@example/linked",
        version: "1.0.0",
        api: 4,
        entry: join(path, "index.ts"),
        subscribers: [
          {
            id: "observe",
            selectors: [{ event: "test:linked" }],
            module: pathToFileURL(join(path, "observe.ts")).href,
          },
        ],
      };
      for (const directory of [first, replacement, registry]) await mkdir(directory, { recursive: true });
      for (const directory of [first, replacement]) {
        await writeFile(join(directory, "package.json"), JSON.stringify({ landoPlugin: manifest }));
        await writeFile(join(directory, "index.ts"), `export const value = ${JSON.stringify(directory)};`);
        await writeFile(join(directory, "observe.ts"), "export default () => {};");
      }
      await symlink(first, path, "junction");
      await writeFile(
        join(registry, "registry.json"),
        JSON.stringify({
          [manifest.name]: { name: manifest.name, version: manifest.version, path },
        }),
      );
      const selected = await Effect.runPromise(
        resolvePluginManifests({
          bundled: [],
          directories: [{ source: "app", path: registry }],
        }),
      );

      await unlink(path);
      await symlink(replacement, path, "junction");
      const layer = PluginContributionGraph.layer<never>(
        {
          cwd: root,
          layers: [],
          manifests: [],
          externalImports: true,
          discovery: { bundled: false, system: false, user: false, app: true, disable: [] },
        },
        [],
      ).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(PathsService, makeLandoPaths()),
            Layer.succeed(PluginManifestResolution, selected),
          ),
        ),
      );
      const plugins = await Effect.runPromise(
        Effect.map(PluginContributionGraph, (graph) => graph.plugins).pipe(Effect.provide(layer)),
      );
      expect(plugins).toMatchObject([
        {
          module: { value: first },
          implementation: { realpath: first },
          manifest: { subscribers: [{ module: pathToFileURL(join(first, "observe.ts")).href }] },
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses bundled then system then user then app then explicit identity precedence", () => {
    // Given
    const groups = [
      [loaded("bundled", "1.0.0")],
      [loaded("system", "2.0.0")],
      [loaded("user", "3.0.0")],
      [loaded("app", "4.0.0")],
      [loaded("explicit", "5.0.0")],
    ];

    // When
    const merged = mergeLoadedPluginSources(groups, []);

    // Then
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("explicit");
    expect(merged[0]?.manifest.version).toBe("5.0.0");
  });

  test("applies disable after every source override", () => {
    // Given
    const groups = [[loaded("bundled", "1.0.0")], [loaded("explicit", "5.0.0")]];

    // When
    const merged = mergeLoadedPluginSources(groups, ["@example/shared"]);

    // Then
    expect(merged).toEqual([]);
  });

  test("labels statically imported modules as bundled rather than system", () => {
    // Given
    const module = loaded("bundled", "1.0.0").entry;
    if (module === undefined) throw new Error("Expected a loaded bundled plugin module.");

    // When
    const [plugin] = systemPluginsFromModules([module]);

    // Then
    expect(plugin?.source).toBe("bundled");
  });

  test("projects executable command loaders from a real plugin descriptor", async () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/commands",
      version: "1.0.0",
      api: 4,
      contributes: { commands: [{ id: "meta:example:hello", summary: "Example hello." }] },
    });
    const module = definePlugin({
      name: manifest.name,
      manifest,
      commands: new Map([
        [
          "meta:example:hello",
          async () => ({
            id: "meta:example:hello",
            summary: "Hello.",
            namespace: "meta" as const,
            bootstrap: "plugins" as const,
            resultSchema: Schema.Unknown,
            run: () => Effect.void,
          }),
        ],
      ]),
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "explicit", manifest, entry: module, module }]);

    // Then
    expect(Result.isSuccess(candidates)).toBe(true);
    if (Result.isSuccess(candidates)) {
      expect(candidates.success.map(({ id }) => id)).toEqual(["meta:example:hello"]);
      expect((await candidates.success[0]?.load())?.id).toBe("meta:example:hello");
    }
  });

  test("retains missing loaders as command-local diagnostics", async () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/manifest-only",
      version: "1.0.0",
      api: 4,
      contributes: { commands: [{ id: "example:doctor", summary: "Inspect example." }] },
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "user", manifest }]);

    // Then
    expect(Result.isSuccess(candidates)).toBe(true);
    if (Result.isSuccess(candidates)) {
      expect(candidates.success.map((candidate) => candidate.id)).toEqual(["example:doctor"]);
      await expect(candidates.success[0]?.load()).rejects.toMatchObject({
        _tag: "PluginDescriptorMismatchError",
      });
    }
  });

  test("rejects executable command loaders absent from the manifest", () => {
    // Given
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@example/extra-loader",
      version: "1.0.0",
      api: 4,
      contributes: { commands: [] },
    });
    const module = definePlugin({
      name: manifest.name,
      manifest,
      commands: new Map([
        [
          "example:undeclared",
          async () => ({
            id: "example:undeclared",
            summary: "Undeclared.",
            namespace: "example" as const,
            bootstrap: "plugins" as const,
            resultSchema: Schema.Unknown,
            run: () => Effect.void,
          }),
        ],
      ]),
    });

    // When
    const candidates = pluginCommandCandidates([{ source: "explicit", manifest, entry: module, module }]);

    // Then
    expect(Result.isFailure(candidates)).toBe(true);
    if (Result.isFailure(candidates)) {
      expect(candidates.failure.declared).toEqual([]);
      expect(candidates.failure.provided).toEqual(["example:undeclared"]);
    }
  });
});
