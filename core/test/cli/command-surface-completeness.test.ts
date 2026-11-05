import { expect, test } from "bun:test";
import { HELP_TOPICS, renderColdAllHelp } from "../../src/cli/cold-path-output.ts";
import { buildCommandCatalog, commandDescriptorAliases } from "../../src/cli/command-catalog.ts";
import { buildHelpCatalog } from "../../src/cli/compiled-help.ts";
import {
  BUNDLED_COMMAND_DESCRIPTORS,
  BUNDLED_PLUGIN_MANIFESTS,
} from "../../src/cli/generated/bundled-command-descriptors.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";
import { pluginHelpRows } from "../../src/cli/plugin-command-help.ts";

const plugins = BUNDLED_COMMAND_DESCRIPTORS.map((descriptor) => ({
  id: descriptor.id,
  summary: descriptor.summary,
  descriptor,
  pluginName: descriptor.pluginName,
  source: "bundled" as const,
}));
const declaredCommands = [
  ...Object.values(COMMAND_REGISTRY_MANIFEST.commands).map((entry) => ({
    id: entry.spec.id,
    hidden: entry.hidden,
    tokens: [entry.spec.id, ...entry.aliases],
  })),
  ...BUNDLED_COMMAND_DESCRIPTORS.map((descriptor) => ({
    id: descriptor.id,
    hidden: descriptor.hidden === true,
    tokens: [descriptor.id, ...commandDescriptorAliases(descriptor)],
  })),
];
const catalog = buildCommandCatalog(plugins);

const buildCommandSurfaceCompletenessTable = async () => {
  const machine = buildHelpCatalog(undefined, undefined, {
    rows: plugins,
    metadata: { status: "available" },
  });
  const text = renderColdAllHelp({ style: false, pluginRows: pluginHelpRows(plugins) });
  const reference = await Bun.file(new URL("../../../docs/reference/commands.mdx", import.meta.url)).text();
  const referenceIds = [...reference.matchAll(/^## `lando ([^`]+)`$/gm)].map((match) => match[1]);
  return declaredCommands
    .filter((entry) => !entry.hidden)
    .map((entry) => ({
      ...entry,
      catalogEntry: catalog.resolve(entry.id),
      helpRows: machine.all.filter((row) => row.canonicalId === entry.id),
      textRows: text
        .split("\n")
        .filter(
          (line) =>
            line.startsWith("  ") && entry.tokens.some((token) => line.trimStart().startsWith(`${token} `)),
        ),
      referenceCount: referenceIds.filter((id) => id === entry.id).length,
    }));
};

test("every visible command has exactly one catalog, help --all and generated reference row", async () => {
  const table = await buildCommandSurfaceCompletenessTable();
  expect(table.length).toBeGreaterThan(0);
  for (const row of table) {
    expect(row.catalogEntry?.id, row.id).toBe(row.id);
    expect(row.helpRows, row.id).toHaveLength(1);
    expect(row.textRows, row.id).toHaveLength(1);
    expect(row.referenceCount, row.id).toBe(1);
  }
});

test("every declared invocation token routes to its canonical owner without silently dropped aliases", () => {
  for (const entry of declaredCommands) {
    for (const token of entry.tokens) expect(catalog.resolve(token)?.id, token).toBe(entry.id);
    expect(catalog.resolve(entry.id)?.tokens.toSorted(), entry.id).toEqual(
      [...new Set(entry.tokens)].toSorted(),
    );
  }
});

test("invocation claims have one owner, with only recipes and scratch sharing help-topic ownership", () => {
  expect(new Set(declaredCommands.map((entry) => entry.id)).size).toBe(declaredCommands.length);
  const claims = new Map<string, Set<string>>();
  for (const entry of declaredCommands) {
    for (const token of entry.tokens) {
      const owners = claims.get(token) ?? new Set<string>();
      owners.add(entry.id);
      claims.set(token, owners);
    }
  }
  expect([...claims.keys()].toSorted()).toEqual([...catalog.byToken.keys()].toSorted());
  for (const [token, owners] of claims) expect(owners.size, token).toBe(1);
  const sharedTopics = HELP_TOPICS.filter((topic) => claims.has(topic));
  expect(sharedTopics.toSorted()).toEqual(["recipes", "scratch"]);
  expect(catalog.resolve("recipes")?.id).toBe("meta:recipes:list");
  expect(catalog.resolve("scratch")?.id).toBe("apps:scratch:start");
});

test("every bundled descriptor matches its owning plugin manifest in both directions", () => {
  const manifestCommands = BUNDLED_PLUGIN_MANIFESTS.flatMap((manifest) =>
    (manifest.contributes?.commands ?? []).map((descriptor) => ({ pluginName: manifest.name, descriptor })),
  );
  expect(BUNDLED_COMMAND_DESCRIPTORS).toHaveLength(manifestCommands.length);
  expect(BUNDLED_COMMAND_DESCRIPTORS.map((entry) => [entry.pluginName, entry.id]).toSorted()).toEqual(
    manifestCommands.map((entry) => [entry.pluginName, entry.descriptor.id]).toSorted(),
  );
  for (const {
    pluginName,
    source,
    flags: _flags,
    args: _args,
    ...descriptor
  } of BUNDLED_COMMAND_DESCRIPTORS) {
    expect(source).toBe("bundled");
    expect(
      manifestCommands.filter(
        (entry) => entry.pluginName === pluginName && entry.descriptor.id === descriptor.id,
      ),
    ).toEqual([{ pluginName, descriptor }]);
  }
});
