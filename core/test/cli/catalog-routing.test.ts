import { expect, test } from "bun:test";
import { createCatalogFixture } from "./fixtures/catalog-fixture.ts";

test("deprecated plugin aliases preserve canonical identity and emit their notice", async () => {
  const f = await createCatalogFixture();
  try {
    await f.install("@example/first", [
      {
        id: "fx:inspect",
        summary: "Inspect fixture.",
        topLevelAlias: {
          name: "inspect",
          deprecated: { since: "4.2.0", severity: "warn", note: "Use fx:inspect." },
        },
      },
    ]);
    expect((await f.invoke(["app:cache:refresh"])).exit).toBe(0);
    const run = await f.invoke(["inspect", "--format=json"]);
    expect(run.exit, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.command).toBe("fx:inspect");
    expect(run.stderr).toContain("Deprecated command inspect");
    expect(run.stderr).toContain("Use fx:inspect.");
  } finally {
    await f.cleanup();
  }
});

test("scenario 4: descriptor aliases route and reserved aliases report their owners", async () => {
  const f = await createCatalogFixture();
  try {
    await f.install("@example/first", [
      { id: "fx:inspect", summary: "Inspect fixture.", aliases: ["fx:i"], topLevelAlias: "inspect" },
      { id: "fx:blocked", summary: "Blocked alias.", topLevelAlias: "start" },
    ]);
    expect((await f.invoke(["app:cache:refresh"])).exit).toBe(0);
    for (const token of ["inspect", "fx:i"]) {
      const result = await f.invoke([token, "--format=json"]);
      expect(result.exit, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).result).toBe("@example/first");
      expect(JSON.parse(result.stdout).command).toBe("fx:inspect");
    }
    const help = JSON.parse((await f.invoke(["help", "--format=json"])).stdout).result;
    expect(help.all).toContainEqual(
      expect.objectContaining({
        canonicalId: "fx:inspect",
        typeable: "inspect",
        extras: expect.arrayContaining(["fx:i"]),
      }),
    );
    expect(help.pluginMetadata.diagnostics).toContainEqual(
      expect.objectContaining({
        _tag: "CommandAliasConflictError",
        message: "Alias start for fx:blocked (@example/first) is ignored because app:start owns it.",
        winner: { source: "built-in", commandId: "app:start" },
        loser: { pluginName: "@example/first", source: "app", commandId: "fx:blocked" },
      }),
    );
    const all = await f.invoke(["help", "--all"]);
    expect(all.stdout).toContain(
      "Plugin command conflicts:\n  Alias start for fx:blocked (@example/first) is ignored because app:start owns it.",
    );
    expect(
      JSON.parse((await f.invoke(["start", "--help", "--format=json"])).stdout).result.target.canonicalId,
    ).toBe("app:start");
  } finally {
    await f.cleanup();
  }
});

test("scenario 5: tooling keeps a plugin alias without failing refresh", async () => {
  const f = await createCatalogFixture();
  try {
    await f.install("@example/first", [
      { id: "fx:inspect", summary: "Inspect fixture.", topLevelAlias: "inspect" },
    ]);
    await f.landofile('tooling:\n  inspect:\n    service: ":host"\n    cmd: echo tooling-owner\n');
    const refresh = await f.invoke(["app:cache:refresh"]);
    expect(refresh.exit, refresh.stderr).toBe(0);
    const run = await f.invoke(["inspect"]);
    expect(run.exit, run.stderr).toBe(0);
    expect(run.stdout).toContain("tooling-owner");
    const help = JSON.parse((await f.invoke(["help", "--format=json"])).stdout).result;
    expect(help.pluginMetadata.diagnostics).toContainEqual(
      expect.objectContaining({
        _tag: "CommandAliasConflictError",
        winner: { source: "tooling", commandId: "app:inspect" },
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("scenario 6: custom aliases target plugin ids in refresh, routing and help rows", async () => {
  const f = await createCatalogFixture();
  try {
    await f.landofile("commandAliases:\n  custom:\n    dump: db:export\n");
    const refresh = await f.invoke(["app:cache:refresh"]);
    expect(refresh.exit, refresh.stderr).toBe(0);
    const target = await f.invoke(["dump", "--help", "--format=json"]);
    expect(target.exit, target.stderr).toBe(0);
    expect(JSON.parse(target.stdout).result.target).toMatchObject({
      canonicalId: "db:export",
      typeable: "dump",
      implementation: "validated",
    });
    expect((await f.invoke(["help", "--all"])).stdout).toMatch(/dump\s+Export a database dump/u);
  } finally {
    await f.cleanup();
  }
});

test("scenario 7: topics own both help spellings even when aliases are disabled", async () => {
  const f = await createCatalogFixture();
  try {
    expect((await f.invoke(["recipes"])).stdout).toContain("wordpress");
    for (const policy of [
      "",
      "commandAliases:\n  enabled: false\n",
      "commandAliases:\n  custom:\n    recipes: meta:version\n",
    ]) {
      await f.landofile(policy);
      expect((await f.invoke(["app:cache:refresh"])).exit).toBe(0);
      for (const topic of ["recipes", "scratch"])
        for (const args of [
          ["help", topic],
          [topic, "--help"],
        ]) {
          const result = await f.invoke(args);
          expect(result.exit, result.stderr).toBe(0);
          expect(result.stdout).toContain(topic.toUpperCase());
          const machine = await f.invoke([...args, "--format=json"]);
          expect(JSON.parse(machine.stdout).result.all).toBeArray();
        }
    }
    expect(
      JSON.parse((await f.invoke(["help", "meta:recipes:list", "--format=json"])).stdout).result.target
        .canonicalId,
    ).toBe("meta:recipes:list");
  } finally {
    await f.cleanup();
  }
}, 60000);

test("scenario 8: duplicate ids retain their first owner and missing loaders are command-local", async () => {
  const f = await createCatalogFixture();
  try {
    await f.install("@example/first", [
      { id: "fx:inspect", summary: "First owner." },
      { id: "fx:missing", summary: "Missing loader." },
    ]);
    await f.install("@example/second", [{ id: "fx:inspect", summary: "Second owner." }]);
    const run = await f.invoke(["fx:inspect", "--format=json"]);
    expect(run.exit, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).result).toBe("@example/first");
    const help = JSON.parse((await f.invoke(["help", "--format=json"])).stdout).result;
    expect(help.pluginMetadata.diagnostics).toContainEqual(
      expect.objectContaining({
        winner: { pluginName: "@example/first", source: "app", commandId: "fx:inspect" },
        loser: { pluginName: "@example/second", source: "app", commandId: "fx:inspect" },
      }),
    );
    const missing = await f.invoke(["fx:missing", "--help", "--format=json"]);
    expect(missing.exit).toBe(1);
    expect(JSON.parse(missing.stdout).error._tag).toBe("PluginDescriptorMismatchError");
  } finally {
    await f.cleanup();
  }
});

test("a missing tooling cache refuses a bare plugin alias and names the plugin command", async () => {
  const f = await createCatalogFixture();
  try {
    await f.install("@example/first", [
      { id: "fx:inspect", summary: "Inspect fixture.", topLevelAlias: "inspect" },
    ]);
    // Given no app:cache:refresh, a tooling task named inspect could still own the token.
    const run = await f.invoke(["inspect", "--format=json"]);
    expect(run.exit).not.toBe(0);
    const error = JSON.parse(run.stdout).error;
    expect(error._tag).toBe("ToolingCommandUnavailableError");
    expect(error.remediation).toContain("Run `lando fx:inspect` to run the plugin command directly.");
    const direct = await f.invoke(["fx:inspect", "--format=json"]);
    expect(direct.exit, direct.stderr).toBe(0);
  } finally {
    await f.cleanup();
  }
});
