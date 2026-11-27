import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { PluginContributionGraph } from "../../src/plugins/contribution-graph.ts";
import { scratchForkSourceLayer } from "../../src/scratch-app/fork-source.ts";
import { selectScratchForkSource } from "../../src/scratch-app/landofile.ts";
import { layer as fileSystemLayer } from "../../src/services/file-system.ts";

const writeApp = async (root: string, marker: string) => {
  const registry = join(root, ".lando", "plugins");
  const path = join(registry, "probe");
  const name = "@example/scratch-source";
  const manifest = { name, version: "1.0.0", api: 4, entry: "index.ts" };
  await mkdir(path, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".lando.yml"), "name: fork-source-probe\n"),
    writeFile(join(path, "package.json"), JSON.stringify({ landoPlugin: manifest })),
    writeFile(
      join(registry, "registry.json"),
      JSON.stringify({ [name]: { name, version: manifest.version, path } }),
    ),
    writeFile(join(path, "index.ts"), `await Bun.write(${JSON.stringify(marker)}, "imported"); export {};`),
  ]);
};

test.each(["excluded", "replaced"] as const)(
  "refuses a %s source before importing its app-local graph",
  async (condition) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "lando-fork-source-")));
    try {
      const paths = makeLandoPaths({ userDataRoot: join(cwd, "relocated-data") });
      const root = join(condition === "excluded" ? paths.scratchDir : cwd, "target");
      const marker = join(cwd, "plugin-imported");
      const source = { kind: "fork", path: root } as const;
      await writeApp(root, marker);

      const replaceRoot = Layer.effectDiscard(
        Effect.promise(async () => {
          await rename(root, join(cwd, "original"));
          await writeApp(root, marker);
        }),
      );
      const graphLayer = PluginContributionGraph.layer(
        {
          layers: [scratchForkSourceLayer(cwd, source), ...(condition === "replaced" ? [replaceRoot] : [])],
          cwd,
          manifests: [],
          discovery: { bundled: false, user: false, system: false, app: true, disable: [] },
          externalImports: true,
        },
        [],
      );
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const graph = yield* PluginContributionGraph;
          return yield* Effect.flip(
            selectScratchForkSource(
              { cwd, source, graph },
              {
                full: true,
                noLocalOverrides: undefined,
                inputs: {
                  ports: { resolveUserCacheRoot: () => cwd, resolveUserIncludesDir: () => cwd, sources: {} },
                  templates: { modules: [] },
                },
              },
            ),
          );
        }).pipe(
          Effect.provide(graphLayer),
          Effect.provide(Layer.merge(fileSystemLayer, Layer.succeed(PathsService, paths))),
        ),
      );

      expect(failure).toMatchObject({ _tag: "ScratchAppError", operation: "acquire" });
      if (condition === "excluded") {
        expect(failure.cause).toMatchObject({ _tag: "LandofileNotFoundError" });
      }
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
