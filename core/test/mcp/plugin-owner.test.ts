import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { RedactionService } from "@lando/redaction/service";
import { Effect, Schema } from "effect";
import { mcpRegistryWithPlugins } from "../../src/cli/commands/meta/mcp-plugins";
import { pluginFixtureGraph } from "./plugin-fixture";

test("appPath accepts the listed app owner but rejects another app-local owner without loading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-owner-"));
  try {
    const spec = {
      id: "fixture:inspect",
      namespace: "fixture",
      bootstrap: "app" as const,
      resultSchema: Schema.String,
      run: () => Effect.succeed("retained"),
    };
    const graph = pluginFixtureGraph(spec, { source: "app" });
    const owner = graph.plugins[0];
    if (owner === undefined) throw new Error("Missing fixture owner");
    const apps = [join(root, "listed"), join(root, "other")] as const;
    const paths: string[] = [];
    for (const app of apps) {
      const path = join(app, ".lando/plugins/fixture");
      paths.push(path);
      await mkdir(path, { recursive: true });
      await writeFile(join(app, ".lando.yml"), "name: fixture\n");
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ landoPlugin: { ...owner.manifest, entry: "index.ts" } }),
      );
      await writeFile(join(path, "index.ts"), 'throw new Error("target entry must never load");');
      await writeFile(
        join(app, ".lando/plugins/registry.json"),
        JSON.stringify({
          [owner.manifest.name]: { name: owner.manifest.name, version: "1.0.0", path },
        }),
      );
    }
    const retainedOwner = { ...owner, path: paths[0] };
    const registry = await Effect.runPromise(
      mcpRegistryWithPlugins({ commandEntries: [] }).pipe(
        Effect.provideService(PluginContributionGraph, { ...graph, plugins: [retainedOwner] }),
        Effect.provide(RedactionService.layer),
      ),
    );
    const bind = registry.commandEntries[0]?.spec.bindInput;
    if (bind === undefined) throw new Error("Missing plugin input binder");
    const input = { argv: [], args: {}, flags: {}, interaction: "non-interactive" as const };
    const same = await Effect.runPromise(bind({ ...input, appPath: apps[0] }));
    expect(same).toMatchObject({ interaction: "non-interactive", parsedArgv: [] });
    const other = await Effect.runPromise(Effect.result(bind({ ...input, appPath: apps[1] })));
    expect(other).toMatchObject({ _tag: "Failure", failure: { _tag: "McpToolInputError", path: "appPath" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
