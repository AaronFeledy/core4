#!/usr/bin/env bun
/**
 * Emits the generated command-reference page from the command registry manifest.
 *
 * Universal machine-output flags are injected into every command by the adapter;
 * the page documents them once in the preamble instead of repeating them per command.
 */
import { resolve } from "node:path";

import type { LandoPluginModule } from "@lando/sdk/plugins";
import { Effect } from "effect";
import { buildCommandCatalog, commandDescriptorAliases } from "../core/src/cli/command-catalog.ts";
import { loadPluginSpec } from "../core/src/cli/event-command-target.ts";
import { BUNDLED_COMMAND_DESCRIPTORS } from "../core/src/cli/generated/bundled-command-descriptors.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../core/src/cli/generated/command-registry-manifest.ts";
import { pluginFlagDefinitions } from "../core/src/cli/plugin-owned-command-input.ts";
import { BUNDLED_PLUGIN_MODULES } from "../core/src/plugins/generated/bundled.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "docs/reference/commands.mdx");

// Adapter-injected on every command; documented once in the page preamble.
const UNIVERSAL_FLAGS = new Set(["format", "json"]);

interface ManifestArg {
  readonly name?: string;
  readonly description?: string;
}

interface ManifestFlag {
  readonly name?: string;
  readonly char?: string;
  readonly description?: string;
  readonly type?: string;
  readonly options?: ReadonlyArray<string>;
}

interface ManifestCommand {
  readonly plugin?: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly aliases?: ReadonlyArray<string>;
  readonly args?: Readonly<Record<string, ManifestArg>>;
  readonly flags?: Readonly<Record<string, ManifestFlag>>;
  readonly spec: { readonly id: string; readonly summary?: string };
}

const manifestCommands = (): ReadonlyArray<ManifestCommand> =>
  Object.values(COMMAND_REGISTRY_MANIFEST.commands);

export const bundledPluginCommands = async (
  modules: ReadonlyArray<LandoPluginModule> = BUNDLED_PLUGIN_MODULES,
): Promise<ReadonlyArray<ManifestCommand>> =>
  Promise.all(
    modules.flatMap((plugin) =>
      [...(plugin.commands ?? [])].map(async ([id, load]) => {
        const spec = await Effect.runPromise(
          loadPluginSpec(
            id,
            plugin.name,
            load,
            plugin.manifest.contributes?.commands?.find((entry) => entry.id === id),
          ),
        );
        return {
          spec,
          plugin: plugin.name,
          flags: pluginFlagDefinitions(spec),
          ...(spec.args === undefined ? {} : { args: spec.args }),
        };
      }),
    ),
  );

// Conformance guard: documented universal flags must stay present on public commands.
const assertUniversalFlags = (commands: ReadonlyArray<ManifestCommand>): void => {
  const offenders: Array<string> = [];
  for (const command of commands) {
    if (command.hidden === true) continue;
    const flags = command.flags ?? {};
    const format = flags.format;
    const universal = ["text", "json", "yaml"];
    const hasFormatJson =
      format?.type === "option" && universal.every((value) => (format.options ?? []).includes(value));
    const hasJsonShortcut = flags.json !== undefined;
    if (!hasFormatJson || !hasJsonShortcut) offenders.push(command.spec.id);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Commands missing the universal --format text/json/yaml / --json flags: ${offenders.sort().join(", ")}`,
    );
  }
};

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const summaryOf = (command: ManifestCommand): string => command.spec.summary ?? command.description ?? "";

const renderArgs = (command: ManifestCommand): ReadonlyArray<string> => {
  const args = Object.entries(command.args ?? {}).map(([name, arg]) => ({
    ...arg,
    name: arg.name ?? name,
  }));
  if (args.length === 0) return [];
  const lines = ["", "Arguments:", "", "| Argument | Description |", "| --- | --- |"];
  for (const arg of args.sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`| \`${escapeCell(arg.name)}\` | ${escapeCell(arg.description ?? "")} |`);
  }
  return lines;
};

const flagToken = (flag: ManifestFlag): string => {
  const long = `--${flag.name ?? ""}`;
  const short = flag.char !== undefined ? `, -${flag.char}` : "";
  return `${long}${short}`;
};

const renderFlags = (command: ManifestCommand): ReadonlyArray<string> => {
  const flags = Object.entries(command.flags ?? {})
    .map(([name, flag]) => ({ ...flag, name: flag.name ?? name }))
    .filter((flag) => !UNIVERSAL_FLAGS.has(flag.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (flags.length === 0) return [];
  const lines = ["", "Flags:", "", "| Flag | Description |", "| --- | --- |"];
  for (const flag of flags) {
    const options =
      flag.options !== undefined && flag.options.length > 0
        ? ` (one of ${flag.options.map((option) => `\`${option}\``).join(", ")})`
        : "";
    lines.push(
      `| \`${escapeCell(flagToken(flag))}\` | ${escapeCell(`${flag.description ?? ""}${options}`)} |`,
    );
  }
  return lines;
};

const renderCommand = (command: ManifestCommand): string => {
  const lines: Array<string> = [`## \`lando ${command.spec.id}\``, ""];
  const summary = summaryOf(command);
  if (summary.length > 0) lines.push(summary, "");
  if (command.plugin !== undefined) lines.push(`Provided by \`${command.plugin}\`.`);
  const aliases = (command.aliases ?? []).filter((alias) => alias.length > 0);
  if (aliases.length > 0) {
    lines.push(`Aliases: ${aliases.map((alias) => `\`lando ${alias}\``).join(", ")}`);
  }
  lines.push(...renderArgs(command));
  lines.push(...renderFlags(command));
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderPage = (plugins: ReadonlyArray<ManifestCommand> = []): string => {
  const commands = [...manifestCommands(), ...plugins]
    .filter((command) => command.hidden !== true)
    .sort((left, right) => left.spec.id.localeCompare(right.spec.id));
  assertUniversalFlags(commands);

  const header = [
    "---",
    "title: Command Reference",
    "description: Generated reference for built-in and bundled plugin Lando commands and their flags.",
    "---",
    "",
    "{/* GENERATED FILE — do not hand-edit. Regenerate via `bun run codegen:command-reference`. */}",
    "",
    "# Command Reference",
    "",
    "Find built-in and bundled plugin commands, aliases, arguments, and flags below.",
    "Optional plugins document their own commands. Hidden and internal commands are",
    "omitted. This page is generated from command metadata.",
    "",
    "## Machine-readable output",
    "",
    "Every command accepts `--format text`, `--format json`, and `--format yaml`.",
    "The equals forms, such as `--format=json`, work too. Text is the default.",
    "Commands offer `table` or `ndjson` only when they implement that format;",
    "check `lando <command> --help` for the formats that command supports.",
    "",
    "Use `--format=json` or `-j` to run a command and read its result as JSON.",
    "Bare `--json` instead lists selectable result keys without running the command",
    "body. Use `--json=key` to run the command and select a key inside `result`.",
    "Replace `key` with a name from that list. `--jq` applies a jq expression to the",
    "redacted result and prints the expression's output, not the original envelope.",
    "",
    "Non-streaming JSON results use a `CommandResultEnvelope`: `ok: true` carries",
    "the typed `result`; `ok: false` carries the tagged `error`. The command's exit",
    "code is preserved. Streaming commands emit JSON frames and finish with a",
    "result frame instead of emitting one standalone envelope.",
    "",
    "YAML normally emits the same result envelope as one document, including for",
    "streaming commands. Commands that export a product document, such as the",
    "Landofile view, can emit that document instead on success. See",
    "[Script Lando with JSON](../guides/scripting-with-json.mdx) for document",
    "exceptions, projections, streaming results, and error handling.",
    "",
    "Results are redacted before emission. Scripts should consume the structured",
    "result rather than parse human-readable tables. Universal `--format` and",
    "`--json` flags are documented here instead of repeated in each flag table.",
    "",
    "## Confirmation",
    "",
    "Commands that ask for confirmation or destroy state accept `--yes`/`-y`. A",
    "destructive command that never prompts accepts it and ignores it, so scripts",
    "and agents can pass it to every destructive command.",
    "",
    "## Commands",
    "",
  ].join("\n");

  return `${header}\n${commands.map(renderCommand).join("\n")}`;
};

const main = async (): Promise<void> => {
  const catalog = buildCommandCatalog(
    BUNDLED_COMMAND_DESCRIPTORS.map((descriptor) => ({
      id: descriptor.id,
      summary: descriptor.summary,
      pluginName: descriptor.pluginName,
      source: "bundled",
      descriptor,
    })),
  );
  const plugins = BUNDLED_COMMAND_DESCRIPTORS.filter(
    (descriptor) => catalog.resolve(descriptor.id)?.source === "plugin",
  ).map((descriptor) => ({
    spec: { id: descriptor.id, summary: descriptor.summary },
    plugin: descriptor.pluginName,
    hidden: descriptor.hidden === true,
    aliases: commandDescriptorAliases(descriptor),
    flags: descriptor.flags,
    args: descriptor.args,
  }));
  await Bun.write(OUTPUT, renderPage(plugins));
  console.log(`[build-command-reference] wrote ${OUTPUT}`);
};

if (import.meta.main) await main();

export { renderPage, assertUniversalFlags };
