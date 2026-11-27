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
 * Commands whose own render produces a table. Write-verb and prose-only
 * commands stay off this list even when they once defaulted `--format` to
 * `table`; advertising a format they do not emit is refused at the boundary.
 */
const TABLE_COMMANDS = [
  "app:config",
  "app:config:describe",
  "app:config:translate",
  "apps:list",
  "apps:scratch:list",
  "meta:config",
  "meta:global:config",
  "meta:global:config:describe",
  "meta:global:info",
  "meta:global:list",
  "meta:global:status",
  "meta:recipes:list",
] as const;

/** Commands that stream frames under `--format=json`, plus doctor's own report. */
const NDJSON_COMMANDS = [
  "app:exec",
  "app:logs",
  "app:rebuild",
  "app:ssh",
  "app:start",
  "apps:scratch:logs",
  "apps:scratch:run",
  "meta:doctor",
  "meta:global:logs",
] as const;

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
    expect([...commandResultFormats({ rendersTable: true })]).toEqual(["text", "json", "yaml", "table"]);
    // advertisedFormats is the manifest-side pre-computed set
    expect(supportsResultFormat({ advertisedFormats: ["ndjson"] }, "ndjson")).toBe(true);
    expect(supportsResultFormat({ advertisedFormats: ["ndjson"] }, "table")).toBe(false);
  });

  test("a frame-streaming command offers ndjson without declaring it", () => {
    expect([...commandResultFormats({ streaming: {} })]).toEqual(["text", "json", "yaml", "ndjson"]);
    expect([...commandResultFormats({ streamingMode: "live" })]).toEqual(["text", "json", "yaml", "ndjson"]);
    expect([...commandResultFormats({ ndjsonReport: {} })]).toEqual(["text", "json", "yaml", "ndjson"]);
    // A per-input live mode alone does not stream frames for every input.
    expect(supportsResultFormat({ streamingMode: () => "live" }, "ndjson")).toBe(false);
  });
});

describe("per-command result-format capability", () => {
  test("exactly the commands that render a table declare it", () => {
    const declared = builtInCommandEntries
      .filter((entry) => entry.spec.rendersTable === true && entry.status.kind === "implemented")
      .map((entry) => entry.spec.id)
      .sort();
    expect(declared).toEqual([...TABLE_COMMANDS]);
  });

  test("exactly the frame-streaming commands and doctor's report offer ndjson", () => {
    const offered = builtInCommandEntries
      .filter((entry) => supportsResultFormat(entry.spec, "ndjson"))
      .map((entry) => entry.spec.id)
      .sort();
    expect(offered).toEqual([...NDJSON_COMMANDS]);
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
    expect(flagDefinitionsForCommand(specForId("meta:recipes:validate")).format?.options).toEqual([
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
      const spec = command as { readonly spec?: { readonly advertisedFormats?: readonly string[] } };
      const optIn = spec.spec?.advertisedFormats ?? [];
      expect([...(options ?? [])]).toEqual(["text", "json", "yaml", ...optIn]);
    }
  });

  test("the manifest offers exactly what each spec produces", () => {
    for (const entry of builtInCommandEntries) {
      expect(manifestFormatOptions(entry.spec.id)).toEqual([...commandResultFormats(entry.spec)]);
    }
  });

  test("version drops table and ndjson; doctor and streaming commands keep ndjson", () => {
    expect(manifestFormatOptions("meta:version")).toEqual(["text", "json", "yaml"]);
    expect(manifestFormatOptions("app:logs")).toEqual(["text", "json", "yaml", "ndjson"]);
    expect(manifestFormatOptions("meta:doctor")).toEqual(["text", "json", "yaml", "ndjson"]);
    expect(manifestFormatOptions("apps:list")).toEqual(["text", "json", "yaml", "table"]);
    expect(manifestFormatOptions("meta:recipes:validate")).toEqual(["text", "json", "yaml"]);
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
    expect(renderCommandHelp({ spec: specForId("app:exec"), status: { kind: "implemented" } })).toContain(
      "--format (text, json, yaml, ndjson)",
    );
  });
});
