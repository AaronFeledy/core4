import { describe, expect, test } from "bun:test";

import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

import { compilePluginCommands, compileToolingCommands } from "../../src/cache/command-compiler.ts";

const landofile = (tooling: LandofileShape["tooling"]): LandofileShape => ({
  name: "myapp",
  tooling,
});

describe("compileToolingCommands", () => {
  test("returns an empty list when the Landofile has no tooling section", () => {
    expect(compileToolingCommands(landofile(undefined))).toEqual([]);
  });

  test("maps tooling.<name> entries to app:<name> command index entries sorted by id", () => {
    const entries = compileToolingCommands(
      landofile({
        zoo: { service: "appserver", description: "Z thing", cmd: "z" },
        composer: { service: "appserver", description: "Run Composer", cmd: "composer" },
        test: { service: "appserver", summary: "Tests", cmds: ["composer install", "phpunit"] },
      }),
    );

    expect(entries).toEqual([
      { id: "app:composer", summary: "Run Composer", hidden: false, service: "appserver" },
      { id: "app:test", summary: "Tests", hidden: false, service: "appserver" },
      { id: "app:zoo", summary: "Z thing", hidden: false, service: "appserver" },
    ]);
  });

  test("prefers description over summary and falls back to an empty string", () => {
    const entries = compileToolingCommands(
      landofile({
        composer: { service: "appserver", description: "desc", summary: "ignored", cmd: "x" },
        build: { service: "appserver", summary: "summary only", cmd: "x" },
        plain: { service: "appserver", cmd: "x" },
      }),
    );
    const byId = (id: string) => entries.find((entry) => entry.id === id);
    expect(byId("app:composer")?.summary).toBe("desc");
    expect(byId("app:build")?.summary).toBe("summary only");
    expect(byId("app:plain")?.summary).toBe("");
  });

  test("omits the service field when the tooling task has no service binding", () => {
    const [entry] = compileToolingCommands(landofile({ build: { cmd: "make" } }));
    expect(entry).toEqual({ id: "app:build", summary: "", hidden: false });
    expect(entry).not.toHaveProperty("service");
  });
});

const manifest = (name: string, commands?: ReadonlyArray<string>): PluginManifest => ({
  name: name as PluginManifest["name"],
  version: "0.0.0",
  api: 4,
  contributes: commands === undefined ? undefined : { commands },
});

describe("compilePluginCommands", () => {
  test("returns an empty list when no plugin contributes commands", () => {
    const entries = compilePluginCommands([manifest("@lando/a"), manifest("@lando/b", [])]);
    expect(entries).toEqual([]);
  });

  test("flattens contributed command ids across plugins, sorted by id", () => {
    const entries = compilePluginCommands([
      manifest("@lando/b", ["b:bravo", "b:alpha"]),
      manifest("@lando/a", ["a:zulu", "a:mike"]),
    ]);
    expect(entries).toEqual([
      { id: "a:mike", summary: "", hidden: false },
      { id: "a:zulu", summary: "", hidden: false },
      { id: "b:alpha", summary: "", hidden: false },
      { id: "b:bravo", summary: "", hidden: false },
    ]);
  });

  test("deduplicates duplicate command ids across plugins", () => {
    const entries = compilePluginCommands([
      manifest("@lando/a", ["meta:plugin:add"]),
      manifest("@lando/b", ["meta:plugin:add"]),
    ]);
    expect(entries).toEqual([{ id: "meta:plugin:add", summary: "", hidden: false }]);
  });
});
