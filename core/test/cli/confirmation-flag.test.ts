import { beforeAll, describe, expect, test } from "bun:test";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";

import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { appsScratchDestroySpec } from "../../src/cli/command-specs/apps/scratch/destroy.ts";
import { flagDefinitionsForCommand } from "../../src/cli/compiled-argv.ts";
import { validateCommandCliFlags } from "../../src/cli/flag-value-validation.ts";
import {
  pluginFlagDefinitions,
  pluginOwnedCliFlagError,
  pluginOwnedCommandInputFromArgv,
  renderPluginOwnedCommandHelp,
} from "../../src/cli/run-plugin-owned-command.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";

const DESTRUCTIVE_VERBS = new Set([
  "destroy",
  "remove",
  "uninstall",
  "prune",
  "gc",
  "reset",
  "restore",
  "rebuild",
  "poweroff",
]);

const pluginSpecs: ExecutableCommandSpec[] = [];

beforeAll(async () => {
  for (const plugin of BUNDLED_PLUGIN_MODULES) {
    for (const load of plugin.commands?.values() ?? []) {
      pluginSpecs.push(await load());
    }
  }
});

const effectiveCommands = () => [
  ...builtInCommandEntries.map(({ spec }) => ({ id: spec.id, flags: flagDefinitionsForCommand(spec) })),
  ...pluginSpecs.map((spec) => ({ id: spec.id, flags: pluginFlagDefinitions(spec) })),
];

const sqlSpec = (id: string) => {
  const spec = pluginSpecs.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`Missing bundled command ${id}`);
  return spec;
};

describe("registry-wide confirmation flags", () => {
  test("every effective yes flag is boolean with short form y", () => {
    // Given
    const commands = effectiveCommands();
    // When
    const invalid = commands.filter(
      ({ flags }) => flags.yes !== undefined && (flags.yes.type !== "boolean" || flags.yes.char !== "y"),
    );
    // Then
    expect(pluginSpecs.length).toBeGreaterThan(0);
    expect(invalid.map(({ id }) => id)).toEqual([]);
  });

  test("no other effective flag claims short form y", () => {
    // Given
    const commands = effectiveCommands();
    // When
    const collisions = commands.flatMap(({ id, flags }) =>
      Object.entries(flags)
        .filter(([name, flag]) => name !== "yes" && flag.char === "y")
        .map(([name]) => `${id}:${name}`),
    );
    // Then
    expect(collisions).toEqual([]);
  });

  test("every destructive verb and scratch stop declares yes", () => {
    // Given
    const commands = effectiveCommands();
    // When
    const missing = commands.filter(
      ({ id, flags }) =>
        // Scratch stop destroys the scratch app, unlike an ordinary app stop.
        (DESTRUCTIVE_VERBS.has(id.split(":").at(-1) ?? "") || id === "apps:scratch:stop") &&
        flags.yes === undefined,
    );
    // Then
    expect(missing.map(({ id }) => id)).toEqual([]);
  });
});

describe("confirmation argv and help", () => {
  const dbCommandIds = [
    "db:restore",
    "db:import",
    "db:export",
    "db:reset",
    "db:snapshot",
    "db:snapshots:prune",
  ];

  for (const id of dbCommandIds) {
    test(`${id} parses -y as yes without consuming its positional`, () => {
      // Given
      const spec = sqlSpec(id);
      const argName = Object.keys(spec.args ?? {})[0];
      const argv = argName === undefined ? ["-y"] : ["snap", "-y"];
      // When
      const parsed = pluginOwnedCommandInputFromArgv(spec, argv);
      // Then
      expect(parsed.flags.yes).toBe(true);
      if (argName !== undefined) expect(parsed.args[argName]).toBe("snap");
    });
  }

  test("DB commands pass strict plugin flag validation with -y", () => {
    for (const id of dbCommandIds) {
      // Given
      const spec = sqlSpec(id);
      // When
      const error = pluginOwnedCliFlagError(spec, ["snap", "-y"]);
      // Then
      expect(error).toBeUndefined();
    }
  });

  test("plugin help advertises -y for the yes flag", () => {
    for (const id of dbCommandIds) {
      // Given
      const spec = sqlSpec(id);
      // When
      const help = renderPluginOwnedCommandHelp(spec);
      // Then
      expect(help).toContain("--yes, -y");
    }
  });

  test("db:export help advertises --force-tty and a dash stdout dump", () => {
    const spec = sqlSpec("db:export");
    const help = renderPluginOwnedCommandHelp(spec);
    expect(help).toContain("--force-tty");
    expect(help).toContain("stdout");
    const parsed = pluginOwnedCommandInputFromArgv(spec, ["-", "--force-tty"]);
    expect(parsed.args.file).toBe("-");
    expect(parsed.flags["force-tty"]).toBe(true);
    expect(spec.payloadStdout?.({ argv: [], parsedArgv: ["-"], flags: {}, args: { file: "-" } })).toBe(true);
    expect(spec.payloadStdout?.({ argv: [], parsedArgv: ["dump.sql"], flags: {}, args: { file: "dump.sql" } })).toBe(
      false,
    );
  });

  test("db:import help advertises a dash stdin dump", () => {
    const spec = sqlSpec("db:import");
    const help = renderPluginOwnedCommandHelp(spec);
    expect(help).toContain("stdin");
    const parsed = pluginOwnedCommandInputFromArgv(spec, ["-"]);
    expect(parsed.args.file).toBe("-");
  });

  for (const flag of ["--yes", "-y"]) {
    test(`scratch:destroy accepts ${flag} in CLI flag validation`, () => {
      // Given
      const spec = appsScratchDestroySpec;
      // When
      const error = validateCommandCliFlags({
        commandId: spec.id,
        argv: ["scratch-id", flag],
        definitions: flagDefinitionsForCommand(spec),
        allowUnknownFlags: spec.strict === false,
      });
      // Then
      expect(error).toBeUndefined();
    });
  }

  for (const id of ["apps:init", "meta:setup"]) {
    test(`${id} parses -y as yes`, () => {
      // Given
      const argv = ["-y"];
      // When
      const input = compiledCommandInputFromArgv(id, argv);
      // Then
      expect(input.flags.yes).toBe(true);
    });
  }
});
