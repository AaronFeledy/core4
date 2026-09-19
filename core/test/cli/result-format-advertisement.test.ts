import { describe, expect, test } from "bun:test";

import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { renderCommandHelp } from "../../src/cli/cli-help.ts";
import { commandRegistryManifest, flagDefinitionsForCommand } from "../../src/cli/compiled-argv.ts";
import {
  OPT_IN_RESULT_FORMATS,
  UNIVERSAL_RESULT_FORMATS,
  commandResultFormats,
  supportsResultFormat,
  universalFormatFlagDefs,
} from "../../src/cli/format-flags.ts";

/**
 * Commands whose own render produces a table. Derived from the specs that used
 * to carry `options: ["table", ...]` on their `format` flag, and frozen here so
 * a new spec cannot quietly claim or drop the capability.
 */
const TABLE_COMMANDS = [
  "app:config",
  "app:config:edit",
  "app:config:set",
  "app:config:translate",
  "app:config:unset",
  "app:config:validate",
  "apps:list",
  "apps:scratch:info",
  "apps:scratch:list",
  "meta:config",
  "meta:global:config",
  "meta:global:config:edit",
  "meta:global:config:set",
  "meta:global:config:unset",
  "meta:global:config:validate",
  "meta:global:info",
  "meta:global:list",
  "meta:global:status",
  "meta:recipes:describe",
  "meta:recipes:list",
  "meta:recipes:validate",
] as const;

const NDJSON_COMMANDS = ["meta:doctor"] as const;

const specForId = (id: string) => {
  const entry = builtInCommandEntries.find((candidate) => candidate.spec.id === id);
  if (entry === undefined) throw new Error(`No built-in command spec for ${id}`);
  return entry.spec;
};

const manifestFormatOptions = (id: string): ReadonlyArray<string> | undefined => {
  const command = (
    commandRegistryManifest.commands as Readonly<
      Record<string, { readonly flags?: Readonly<Record<string, { readonly options?: readonly string[] }>> }>
    >
  )[id];
  return command?.flags?.format?.options;
};

describe("universal result-format advertisement", () => {
  test("only the formats the boundary honors for every command are universal", () => {
    expect([...UNIVERSAL_RESULT_FORMATS]).toEqual(["text", "json", "yaml"]);
    expect([...OPT_IN_RESULT_FORMATS]).toEqual(["table", "ndjson"]);
    expect(universalFormatFlagDefs.format.options).toEqual(["text", "json", "yaml"]);
  });

  test("a command declares nothing and gets exactly the universal set", () => {
    expect([...commandResultFormats(undefined)]).toEqual(["text", "json", "yaml"]);
    expect([...commandResultFormats({})]).toEqual(["text", "json", "yaml"]);
    expect(supportsResultFormat({}, "yaml")).toBe(true);
    expect(supportsResultFormat({}, "table")).toBe(false);
    expect(supportsResultFormat({}, "ndjson")).toBe(false);
  });

  test("an opt-in format extends the universal set rather than replacing it", () => {
    expect([...commandResultFormats({ resultFormats: ["table"] })]).toEqual([
      "text",
      "json",
      "yaml",
      "table",
    ]);
    expect(supportsResultFormat({ resultFormats: ["ndjson"] }, "ndjson")).toBe(true);
    expect(supportsResultFormat({ resultFormats: ["ndjson"] }, "table")).toBe(false);
  });
});

describe("per-command result-format capability", () => {
  test("exactly the commands that render a table declare it", () => {
    const declared = builtInCommandEntries
      .filter((entry) => entry.spec.resultFormats?.includes("table") === true)
      .map((entry) => entry.spec.id)
      .sort();
    expect(declared).toEqual([...TABLE_COMMANDS]);
  });

  test("exactly the commands that emit a frame stream declare ndjson", () => {
    const declared = builtInCommandEntries
      .filter((entry) => entry.spec.resultFormats?.includes("ndjson") === true)
      .map((entry) => entry.spec.id)
      .sort();
    expect(declared).toEqual([...NDJSON_COMMANDS]);
  });

  test("no spec carries a competing format option list of its own", () => {
    const offenders = builtInCommandEntries
      .filter(
        (entry) =>
          (entry.spec.flags as Readonly<Record<string, { readonly options?: readonly string[] }>> | undefined)
            ?.format?.options !== undefined,
      )
      .map((entry) => entry.spec.id);
    expect(offenders).toEqual([]);
  });
});

describe("compiled-mode argv definitions", () => {
  test("a command that implements neither opt-in format advertises neither", () => {
    expect(flagDefinitionsForCommand(specForId("meta:version")).format?.options).toEqual([
      "text",
      "json",
      "yaml",
    ]);
    expect(flagDefinitionsForCommand(specForId("app:info")).format?.options).toEqual([
      "text",
      "json",
      "yaml",
    ]);
  });

  test("a table command advertises table on top of the universal set", () => {
    expect(flagDefinitionsForCommand(specForId("apps:list")).format?.options).toEqual([
      "text",
      "json",
      "yaml",
      "table",
    ]);
  });

  test("doctor advertises the ndjson stream it actually renders", () => {
    expect(flagDefinitionsForCommand(specForId("meta:doctor")).format?.options).toEqual([
      "text",
      "json",
      "yaml",
      "ndjson",
    ]);
  });
});

describe("generated command-registry manifest", () => {
  test("no command is offered a format it drops", () => {
    for (const [id, command] of Object.entries(commandRegistryManifest.commands)) {
      const options = manifestFormatOptions(id);
      expect(options).toBeDefined();
      const spec = command as { readonly spec?: { readonly resultFormats?: readonly string[] } };
      const optIn = spec.spec?.resultFormats ?? [];
      expect([...(options ?? [])]).toEqual(["text", "json", "yaml", ...optIn]);
    }
  });

  test("version drops table and ndjson; doctor keeps ndjson", () => {
    expect(manifestFormatOptions("meta:version")).toEqual(["text", "json", "yaml"]);
    expect(manifestFormatOptions("meta:doctor")).toEqual(["text", "json", "yaml", "ndjson"]);
    expect(manifestFormatOptions("apps:list")).toEqual(["text", "json", "yaml", "table"]);
  });
});

describe("lando help", () => {
  test("names the formats the command supports, not the whole vocabulary", () => {
    const help = renderCommandHelp({ spec: specForId("meta:version"), status: { kind: "implemented" } });
    expect(help).toContain("--format (text, json, yaml)");
    expect(help).not.toContain("table");
    expect(help).not.toContain("ndjson");
  });

  test("names an opt-in format on the command that implements it", () => {
    expect(renderCommandHelp({ spec: specForId("meta:doctor"), status: { kind: "implemented" } })).toContain(
      "--format (text, json, yaml, ndjson)",
    );
    expect(renderCommandHelp({ spec: specForId("apps:list"), status: { kind: "implemented" } })).toContain(
      "--format (text, json, yaml, table)",
    );
  });
});
