import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";
import { renderColdRootHelp } from "../../src/cli/cold-path-output.ts";
import { BUNDLED_PLUGIN_MANIFESTS } from "../../src/cli/generated/bundled-command-descriptors.ts";
import { pluginTopicRows } from "../../src/cli/root-help-topics.ts";
import { createCatalogFixture } from "./fixtures/catalog-fixture.ts";

test("cold root MORE uses the bundled plugin manifest description", () => {
  const sql = BUNDLED_PLUGIN_MANIFESTS.find((manifest) => manifest.name === "@lando/sql");
  const help = renderColdRootHelp(undefined, { style: false });
  expect(sql).toBeDefined();
  expect(
    help
      .split("MORE\n")[1]
      ?.split("\n")
      .find((line) => line.trim().startsWith("lando help db"))
      ?.trim(),
  ).toMatch(new RegExp(`^lando help db\\s+${sql?.description?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("topic projection omits hidden and core namespaces and deduplicates owners", () => {
  const commands = [
    { id: "fx:inspect", pluginName: "fixture" },
    { id: "fx:list", pluginName: "fixture" },
    { id: "secret:inspect", pluginName: "fixture", hidden: true },
    { id: "app:inspect", pluginName: "fixture" },
    { id: "scratch:inspect", pluginName: "fixture" },
  ];
  const topics = pluginTopicRows(commands, [{ name: "fixture", description: "Fixture topic." }]);
  expect(topics).toEqual([{ token: "lando help fx", summary: "Fixture topic." }]);
});

test.each(["app", "user"] as const)(
  "warm root text and machine MORE include %s plugin topics without importing entries",
  async (source) => {
    const fixture = await createCatalogFixture();
    try {
      const pluginRoot =
        source === "app" ? join(fixture.root, ".lando/plugins") : join(fixture.root, "data/plugins");
      const path = join(pluginRoot, "fixture");
      const manifest = {
        name: "@example/root-help",
        version: "1.0.0",
        api: 4,
        entry: "index.ts",
        description: "Root help fixture commands.",
        contributes: { commands: [{ id: "fx:inspect", summary: "Inspect fixture." }] },
      };
      await Bun.write(join(path, "package.json"), JSON.stringify({ landoPlugin: manifest }));
      await Bun.write(join(path, "index.ts"), 'throw new Error("Root listing imported plugin entry");');
      await Bun.write(
        join(pluginRoot, "registry.json"),
        JSON.stringify({ [manifest.name]: { name: manifest.name, version: manifest.version, path } }),
      );
      const text = await fixture.invoke(["--help"]);
      const machine = await fixture.invoke(["help", "--format", "json"]);
      expect(text.exit, text.stderr).toBe(0);
      expect(text.stdout).toMatch(/lando help fx\s+Root help fixture commands\./);
      expect(text.stdout).toContain("lando help db");
      expect(machine.exit, machine.stderr).toBe(0);
      expect(JSON.parse(machine.stdout).result.sections.more).toContainEqual(
        expect.objectContaining({ typeable: "lando help fx", summary: manifest.description }),
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test("generated descriptors have only type imports and pass the cold-path import canary", async () => {
  const descriptorPath = resolve(
    import.meta.dirname,
    "../../src/cli/generated/bundled-command-descriptors.ts",
  );
  const source = ts.createSourceFile(
    descriptorPath,
    await Bun.file(descriptorPath).text(),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = source.statements.filter(ts.isImportDeclaration);
  expect(imports.length).toBeGreaterThan(0);
  expect(
    imports.every((declaration) => declaration.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword),
  ).toBe(true);
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dirname, "fast-path-canary-preload.ts"),
      join(import.meta.dirname, "fixtures/fast-path-canary-probe.ts"),
      descriptorPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exit, stderr] = await Promise.all([child.exited, child.stderr.text()]);
  expect(exit, stderr).toBe(0);
  expect(stderr).not.toContain("FAST_PATH_CANARY");
});
