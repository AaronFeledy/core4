import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { runDiscoveryOperation } from "@lando/landofile/operation-scope";
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
import { makeLandoPaths } from "@lando/paths";
import { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, Logger, PathsService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { mcpAppContextForCwd } from "../../src/mcp/mcp-app-context";
import { makeLandoRuntime } from "../../src/runtime/layer";
import { literalLandofile } from "../_support/value-contracts";

class HostMarker extends Context.Service<HostMarker, { readonly id: string }>()(
  "@lando/test/McpHostMarker",
) {}

test("selected app plans use their own service type while retained host layers are acquired once", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-planner-apps-"));
  const sessionRoot = join(root, "session");
  const pluginName = "@example/selected-type";
  const typeId = "example:selected-type";
  let acquired = 0;
  let finalized = 0;
  const hostLayer = Layer.effect(
    HostMarker,
    Effect.acquireRelease(
      Effect.sync(() => {
        acquired++;
        return HostMarker.of({ id: "retained" });
      }),
      () =>
        Effect.sync(() => {
          finalized++;
        }),
    ),
  );
  const entrySource = (name: string) =>
    [
      `import { Effect, Schema } from ${JSON.stringify(import.meta.resolve("effect"))};`,
      `export const serviceTypes = new Map([[${JSON.stringify(typeId)}, {`,
      `  id: ${JSON.stringify(typeId)}, name: ${JSON.stringify(name)}, base: "l337", schema: Schema.Unknown,`,
      `  resolve: (input) => Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [], tooling: { inspect: { cmd: ${JSON.stringify(name)} } } }),`,
      "}]]);",
    ].join("\n");
  const writeApp = async (name: string) => {
    const app = join(root, name);
    const pluginsRoot = join(app, ".lando", "plugins");
    const packageRoot = join(pluginsRoot, "selected-type");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(app, ".lando.yml"), `name: ${name}\n`);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: pluginName,
        version: "1.0.0",
        landoPlugin: {
          name: pluginName,
          version: "1.0.0",
          api: 4,
          entry: "./entry.mjs",
          contributes: { serviceTypes: [typeId] },
        },
      }),
    );
    await writeFile(join(packageRoot, "entry.mjs"), entrySource(name));
    await writeFile(
      join(pluginsRoot, "registry.json"),
      JSON.stringify({
        [pluginName]: { name: pluginName, version: "1.0.0", path: packageRoot },
      }),
    );
    return app;
  };

  try {
    await mkdir(sessionRoot);
    const left = await writeApp("left");
    const right = await writeApp("right");
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = (yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "app",
              cwd: sessionRoot,
              plugins: {
                policy: "discovery",
                discovery: { bundled: false, system: false, user: false, app: false },
                layers: [hostLayer],
              },
            }),
          )) as Context.Context<unknown>;
          const landofileFor = (app: string) =>
            literalLandofile(
              Schema.decodeSync(LandofileShape)({
                name: "selected",
                services: { web: { type: typeId, home: false } },
              }),
              app,
            );
          const inspectCommand = (plan: { readonly extensions: Readonly<Record<string, unknown>> }) =>
            (
              plan.extensions["@lando/core/effective-tooling"] as {
                readonly tasks: { readonly inspect: { readonly cmd: string } };
              }
            ).tasks.inspect.cmd;
          expect(Context.get(base, PluginContributionGraph).plugins).toEqual([]);
          const hostRegistry = Context.get(base, PluginRegistry);
          const hostPlanner = Context.get(base, AppPlanner);
          const hostGraph = Context.get(base, PluginContributionGraph);
          const overriddenBase = Context.add(
            base,
            PluginContributionGraph,
            PluginContributionGraph.of({
              ...hostGraph,
              hostContext: Context.add(
                Context.add(Context.empty(), PluginRegistry, hostRegistry),
                AppPlanner,
                hostPlanner,
              ),
            }),
          );
          const overridden = yield* mcpAppContextForCwd(overriddenBase, left, { app: true, disable: [] });
          expect(Context.get(overridden, PluginRegistry)).toBe(hostRegistry);
          expect(Context.get(overridden, AppPlanner)).toBe(hostPlanner);
          const plans: string[] = [];
          for (const app of [left, right, left]) {
            const scoped = yield* mcpAppContextForCwd(base, app, { app: true, disable: [] });
            expect(Context.get(scoped, HostMarker).id).toBe("retained");
            const plan = yield* Context.get(scoped, AppPlanner).plan(
              landofileFor(app),
              TestRuntimeProvider.capabilities,
            );
            plans.push(inspectCommand(plan));
          }
          const originalRevision = Context.get(
            yield* mcpAppContextForCwd(base, left, { app: true, disable: [] }),
            PluginContributionGraph,
          ).appPluginSourceRevision;
          yield* Effect.promise(() =>
            writeFile(
              join(left, ".lando", "plugins", "selected-type", "entry.mjs"),
              entrySource("left-edited"),
            ),
          );
          const editedSamePath = yield* mcpAppContextForCwd(base, left, { app: true, disable: [] });
          expect(Context.get(editedSamePath, PluginContributionGraph).appPluginSourceRevision).toBe(
            originalRevision,
          );
          const stillLoaded = yield* Context.get(editedSamePath, AppPlanner).plan(
            landofileFor(left),
            TestRuntimeProvider.capabilities,
          );
          plans.push(inspectCommand(stillLoaded));
          yield* Effect.promise(async () => {
            const pluginsRoot = join(left, ".lando", "plugins");
            const replacement = join(pluginsRoot, "selected-type-replacement");
            await mkdir(replacement);
            await writeFile(
              join(replacement, "package.json"),
              await readFile(join(pluginsRoot, "selected-type", "package.json")),
            );
            await writeFile(join(replacement, "entry.mjs"), entrySource("left-replaced"));
            await writeFile(
              join(pluginsRoot, "registry.json"),
              JSON.stringify({
                [pluginName]: { name: pluginName, version: "1.0.0", path: replacement },
              }),
            );
          });
          const editedContext = yield* mcpAppContextForCwd(base, left, { app: true, disable: [] });
          const editedPlan = yield* Context.get(editedContext, AppPlanner).plan(
            landofileFor(left),
            TestRuntimeProvider.capabilities,
          );
          plans.push(inspectCommand(editedPlan));
          return plans;
        }),
      ),
    );
    expect(observed).toEqual(["left", "right", "left", "left", "left-replaced"]);
    expect(acquired).toBe(1);
    expect(finalized).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["effect", "async-local"] as const)(
  "each MCP appPath refreshes inherited %s discovery when a nearer Landofile appears and disappears",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `lando-mcp-discovery-${mode}-`));
    const parent = join(root, "parent");
    const child = join(parent, "child");
    const parentId = "example:parent";
    const childId = "example:child";
    const install = async (app: string, marker: string) => {
      const pluginRoot = join(app, ".lando", "plugins", "marker");
      const pluginName = `@example/${marker}`;
      const commandId = `example:${marker}`;
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "package.json"),
        JSON.stringify({
          landoPlugin: {
            name: pluginName,
            version: "1.0.0",
            api: 4,
            entry: "./entry.mjs",
            contributes: { commands: [commandId] },
          },
        }),
      );
      await writeFile(
        join(pluginRoot, "entry.mjs"),
        `export const commands = new Map([[${JSON.stringify(commandId)}, async () => ({})]]);`,
      );
      await writeFile(
        join(app, ".lando", "plugins", "registry.json"),
        JSON.stringify({
          [pluginName]: { name: pluginName, version: "1.0.0", path: pluginRoot },
        }),
      );
    };

    try {
      await install(parent, "parent");
      await install(child, "child");
      await writeFile(join(parent, ".lando.yml"), "name: parent\n");
      const paths = makeLandoPaths({ userDataRoot: join(root, "data") });
      const noop = () => Effect.void;
      const base = Context.empty()
        .pipe(Context.add(PathsService, paths))
        .pipe(Context.add(Logger, Logger.of({ debug: noop, info: noop, warn: noop, error: noop })))
        .pipe(
          Context.add(
            PluginContributionGraph,
            PluginContributionGraph.of({
              plugins: [],
              globalPlugins: [],
              commands: [],
              certificateAuthorities: [],
              hostContext: Context.empty(),
            }),
          ),
        ) as Context.Context<unknown>;
      const observed = Effect.scoped(
        Effect.gen(function* () {
          const selectedIds = () =>
            mcpAppContextForCwd(base, child, { app: true, disable: [] }).pipe(
              Effect.map((context) =>
                Context.get(context, PluginContributionGraph).commands.map((command) => command.id),
              ),
            );
          const before = yield* selectedIds();
          yield* Effect.promise(() => writeFile(join(child, ".lando.yml"), "name: child\n"));
          const during = yield* selectedIds();
          yield* Effect.promise(() => rm(join(child, ".lando.yml")));
          const after = yield* selectedIds();
          return [before, during, after];
        }),
      );
      const execute = () =>
        Effect.runPromise(
          (mode === "effect" ? withAppDiscovery(parent, observed) : observed).pipe(
            Effect.provideService(PathsService, paths),
          ),
        );
      const result =
        mode === "async-local"
          ? await runDiscoveryOperation({ cwd: parent, resolver: makeAppDiscoveryResolver() }, execute)
          : await execute();
      expect(result).toEqual([[parentId], [childId], [parentId]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
