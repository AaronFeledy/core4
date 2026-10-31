import { expect, test } from "bun:test";
import { Context, Effect, Schema } from "effect";
import { buildCommandCatalog } from "../../src/cli/command-catalog.ts";
import { buildHelpCatalog } from "../../src/cli/compiled-help.ts";
import { BUNDLED_COMMAND_DESCRIPTORS } from "../../src/cli/generated/bundled-command-descriptors.ts";
import { createPluginCommandCatalog } from "../../src/cli/plugin-command-catalog.ts";

const rows = BUNDLED_COMMAND_DESCRIPTORS.map((descriptor) => ({
  id: descriptor.id,
  summary: descriptor.summary,
  descriptor,
  pluginName: descriptor.pluginName,
  source: "bundled" as const,
}));

test("plugin aliases yield to built-ins, core topics, canonical ids and tooling", () => {
  const descriptor = {
    id: "fx:inspect",
    summary: "Inspect fixture.",
    topLevelAlias: "inspect",
    aliases: ["start", "recipes", "db:export", "fx:i"],
  };
  const catalog = buildCommandCatalog(
    [
      ...rows,
      {
        id: descriptor.id,
        summary: descriptor.summary,
        descriptor,
        pluginName: "@example/fixture",
        source: "app",
      },
    ],
    {
      entries: [{ id: "app:inspect", summary: "Tooling inspect.", hidden: false }],
    },
  );
  expect(catalog.resolve("start")?.id).toBe("app:start");
  expect(catalog.resolve("inspect")?.id).toBe("app:inspect");
  expect(catalog.resolve("fx:i")?.id).toBe("fx:inspect");
  expect(catalog.resolve("db:export")?.plugin?.pluginName).toBe("@lando/sql");
  expect(catalog.diagnostics).toHaveLength(4);
  expect(
    catalog.diagnostics.every(
      (diagnostic) => diagnostic.winner !== undefined && diagnostic.loser?.pluginName === "@example/fixture",
    ),
  ).toBe(true);
});

test("dispatch, machine help and diagnostics keep the discovery-first alias owner", async () => {
  // Given z:run discovered before a:run, both claiming the inspect alias
  const commands = ["z:run", "a:run"].map((id) => ({
    id,
    pluginName: `@example/${id[0]}`,
    source: "explicit" as const,
    descriptor: { id, summary: "Run fixture.", topLevelAlias: "inspect" },
    load: async () => ({
      id,
      namespace: id[0] ?? "fixture",
      bootstrap: "plugins" as const,
      resultSchema: Schema.String,
      run: () => Effect.succeed(id),
    }),
  }));
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed({
      plugins: [],
      globalPlugins: [],
      commands,
      certificateAuthorities: [],
      hostContext: Context.empty(),
    }),
  );
  // When the alias is listed, dispatched and projected into machine help
  const listing = await catalog.list();
  const dispatched = await catalog.resolve("inspect");
  // Then every surface names the discovery-first owner
  expect(dispatched).toMatchObject({ id: "z:run", spec: { id: "z:run" } });
  const help = buildHelpCatalog(undefined, undefined, listing);
  expect(help.all.find((row) => row.typeable === "inspect")?.canonicalId).toBe("z:run");
  expect(listing.metadata).toMatchObject({
    diagnostics: [
      expect.objectContaining({
        winner: { source: "explicit", pluginName: "@example/z", commandId: "z:run" },
        loser: { source: "explicit", pluginName: "@example/a", commandId: "a:run" },
      }),
    ],
  });
});

test("manifest summary enriches omitted module summary and mismatch stays command-local", async () => {
  const commands = ["fx:healthy", "fx:mismatch"].map((id) => ({
    id,
    pluginName: "@example/summary",
    source: "explicit" as const,
    descriptor: { id, summary: "Manifest summary." },
    load: async () => ({
      id,
      namespace: "fx",
      bootstrap: "plugins" as const,
      resultSchema: Schema.Void,
      run: () => Effect.void,
      ...(id === "fx:mismatch" ? { summary: "Different module summary." } : {}),
    }),
  }));
  const catalog = createPluginCommandCatalog(undefined, () =>
    Effect.succeed({
      plugins: [],
      globalPlugins: [],
      commands,
      certificateAuthorities: [],
      hostContext: Context.empty(),
    }),
  );
  expect((await catalog.list()).rows.map((row) => row.summary)).toEqual([
    "Manifest summary.",
    "Manifest summary.",
  ]);
  expect(await catalog.resolve("fx:healthy")).toMatchObject({ spec: { summary: "Manifest summary." } });
  expect(await catalog.resolve("fx:mismatch")).toMatchObject({
    loadError: { _tag: "PluginDescriptorMismatchError" },
  });
  expect((await catalog.list()).rows).toHaveLength(2);
});
