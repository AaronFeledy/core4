#!/usr/bin/env bun
/**
 * Emits the generated command-reference page from the compiled OCLIF manifest.
 *
 * The manifest is the single source of truth for command metadata, so the page
 * always reflects the real CLI surface (including the universal machine-output
 * flags the adapter injects into every command). The preamble documents the
 * universal `--format json` / `--json` / `-j` flag once instead of repeating it
 * on every command.
 */
import { resolve } from "node:path";

import { COMPILED_OCLIF_MANIFEST } from "../core/src/cli/oclif/compiled-manifest.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "docs/reference/commands.mdx");

// Injected into every command by the adapter; documented once in the preamble.
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
  readonly id: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly aliases?: ReadonlyArray<string>;
  readonly args?: Readonly<Record<string, ManifestArg>>;
  readonly flags?: Readonly<Record<string, ManifestFlag>>;
  readonly landoSpec?: { readonly summary?: string };
}

const manifestCommands = (): ReadonlyArray<ManifestCommand> =>
  Object.values(COMPILED_OCLIF_MANIFEST.commands as Record<string, ManifestCommand>);

/**
 * Fail the generator if a public command is missing the universal machine-output
 * flags. This turns the doc generator into a lightweight conformance guard so the
 * documented contract cannot silently drift from the real command surface.
 */
const assertUniversalFlags = (commands: ReadonlyArray<ManifestCommand>): void => {
  const offenders: Array<string> = [];
  for (const command of commands) {
    if (command.hidden === true) continue;
    const flags = command.flags ?? {};
    const format = flags.format;
    const hasFormatJson = format?.type === "option" && (format.options ?? []).includes("json");
    const hasJsonShortcut = flags.json !== undefined;
    if (!hasFormatJson || !hasJsonShortcut) offenders.push(command.id);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Commands missing the universal --format json / --json flags: ${offenders.sort().join(", ")}`,
    );
  }
};

const escapeCell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

const summaryOf = (command: ManifestCommand): string =>
  command.landoSpec?.summary ?? command.description ?? "";

const renderArgs = (command: ManifestCommand): ReadonlyArray<string> => {
  const args = Object.values(command.args ?? {}).filter((arg): arg is ManifestArg => arg.name !== undefined);
  if (args.length === 0) return [];
  const lines = ["", "Arguments:", "", "| Argument | Description |", "| --- | --- |"];
  for (const arg of args.sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""))) {
    lines.push(`| \`${escapeCell(arg.name ?? "")}\` | ${escapeCell(arg.description ?? "")} |`);
  }
  return lines;
};

const flagToken = (flag: ManifestFlag): string => {
  const long = `--${flag.name ?? ""}`;
  const short = flag.char !== undefined ? `, -${flag.char}` : "";
  return `${long}${short}`;
};

const renderFlags = (command: ManifestCommand): ReadonlyArray<string> => {
  const flags = Object.values(command.flags ?? {})
    .filter((flag): flag is ManifestFlag => flag.name !== undefined && !UNIVERSAL_FLAGS.has(flag.name))
    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
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
  const lines: Array<string> = [`## \`lando ${command.id}\``, ""];
  const summary = summaryOf(command);
  if (summary.length > 0) lines.push(summary, "");
  const aliases = (command.aliases ?? []).filter((alias) => alias.length > 0);
  if (aliases.length > 0) {
    lines.push(`Aliases: ${aliases.map((alias) => `\`lando ${alias}\``).join(", ")}`);
  }
  lines.push(...renderArgs(command));
  lines.push(...renderFlags(command));
  return `${lines.join("\n").trimEnd()}\n`;
};

const renderPage = (): string => {
  const commands = manifestCommands()
    .filter((command) => command.hidden !== true)
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUniversalFlags(commands);

  const header = [
    "---",
    "title: Command Reference",
    "description: Generated reference for every public Lando command and its flags.",
    "---",
    "",
    "{/* GENERATED FILE — do not hand-edit. Regenerate via `bun run codegen:command-reference`. */}",
    "",
    "# Command Reference",
    "",
    "This page is generated from the compiled command manifest and lists every public",
    "Lando command. Hidden and internal commands are omitted.",
    "",
    "## Machine-readable output",
    "",
    "Every command accepts the universal `--format json` flag (and its `--format=json`",
    "form) to emit a single machine-readable `CommandResultEnvelope` on stdout. The",
    "`--json` and `-j` shorthands are equivalent to `--format json`. These flags are",
    "injected into every command, so they are not repeated in the per-command flag",
    "tables below.",
    "",
    'On success the envelope is `{ "ok": true, "result": <typed result> }`; on failure',
    'it is `{ "ok": false, "error": <tagged error> }` with the command\'s exit code',
    "preserved. Every envelope is redacted before emission. Agents and scripts should",
    "consume this JSON instead of parsing the rendered tables.",
    "",
    "## Commands",
    "",
  ].join("\n");

  return `${header}\n${commands.map(renderCommand).join("\n")}`;
};

const main = async (): Promise<void> => {
  await writeFormattedOutput(OUTPUT, renderPage());
  console.log(`[build-command-reference] wrote ${OUTPUT}`);
};

if (import.meta.main) await main();

export { renderPage, assertUniversalFlags };
