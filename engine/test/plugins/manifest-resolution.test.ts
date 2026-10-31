import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PluginManifest } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { PluginContributionGraph } from "../../src/plugins/contribution-graph.ts";
import { PluginManifestResolution, resolvePluginManifests } from "../../src/plugins/manifest-resolution.ts";
import { type PluginManifestEntry, selectPluginManifests } from "../../src/plugins/manifest-selection.ts";

const manifest = (name: string, id: string) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name,
    api: 4,
    version: "1.0.0",
    contributes: { commands: [{ id, summary: `Run ${id}.` }] },
  });

test("later sources replace a plugin name before first-owner command selection", () => {
  const bundled = [
    { manifest: manifest("@example/replaced", "old:run"), source: "bundled" as const },
    { manifest: manifest("@example/first", "x:run"), source: "bundled" as const },
  ];
  const user = [
    { manifest: manifest("@example/replaced", "new:run"), source: "user" as const },
    { manifest: manifest("@example/second", "x:run"), source: "user" as const },
  ];
  const selected = selectPluginManifests<PluginManifestEntry>([bundled, user]);
  expect(selected.commands.map((entry) => entry.id)).toEqual(["new:run", "x:run"]);
  expect(selected.diagnostics).toContainEqual(
    expect.objectContaining({
      winner: { pluginName: "@example/first", source: "bundled" },
      loser: { pluginName: "@example/second", source: "user" },
    }),
  );
});

test("manifest inspection retains registry failures and imports zero entry modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-manifest-resolution-"));
  try {
    const path = join(root, "fixture");
    await mkdir(path);
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ landoPlugin: { ...manifest("@example/trap", "trap:run"), entry: "index.ts" } }),
    );
    await writeFile(join(path, "index.ts"), 'throw new Error("entry must not be imported");');
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({
        valid: { name: "@example/trap", version: "1.0.0", path },
        invalid: { name: "broken" },
      }),
    );
    const selected = await Effect.runPromise(
      resolvePluginManifests({ bundled: [], directories: [{ source: "user", path: root }] }),
    );
    expect(selected.commands.map((entry) => entry.id)).toEqual(["trap:run"]);
    expect(selected.diagnostics).toContainEqual(
      expect.objectContaining({
        _tag: "PluginManifestError",
        loser: { pluginName: "invalid", source: "user" },
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a duplicate owner's later command is never promoted by selection", () => {
  const first = { manifest: manifest("@example/broken", "x:run"), source: "bundled" as const };
  const second = { manifest: manifest("@example/working", "x:run"), source: "user" as const };
  expect(selectPluginManifests<PluginManifestEntry>([[first], [second]]).commands[0]?.pluginName).toBe(
    "@example/broken",
  );
});

test("graph imports an already-selected snapshot without reading manifests again", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-selected-manifest-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        landoPlugin: { ...manifest("@example/selected", "selected:run"), entry: "index.ts" },
      }),
    );
    await writeFile(
      join(root, "index.ts"),
      'export const commands = new Map([["selected:run", async () => ({ id: "selected:run" })]]);',
    );
    await writeFile(
      join(root, "registry.json"),
      JSON.stringify({ selected: { name: "@example/selected", version: "1.0.0", path: root } }),
    );
    const selected = await Effect.runPromise(
      resolvePluginManifests({ bundled: [], directories: [{ source: "user", path: root }] }),
    );
    await rm(join(root, "package.json"));
    const layer = PluginContributionGraph.layer<never>(
      {
        cwd: root,
        layers: [],
        manifests: [],
        externalImports: true,
        discovery: { bundled: false, system: false, user: true, app: false, disable: [] },
      },
      [],
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(PathsService, makeLandoPaths()),
          Layer.succeed(PluginManifestResolution, selected),
        ),
      ),
    );
    const graph = await Effect.runPromise(Effect.scoped(PluginContributionGraph.pipe(Effect.provide(layer))));
    expect(graph.commands.map((entry) => entry.id)).toEqual(["selected:run"]);
    expect(graph.diagnostics).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
