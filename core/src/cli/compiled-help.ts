/**
 * Compiled-CLI help rendering for the root command list and per-command usage.
 *
 * The compiled `$bunfs` dispatch path renders help without OCLIF, so these
 * builders format the top-level topic/command listing and a single command's
 * usage/aliases/flags directly from the built-in command registry.
 */
import { CORE_VERSION } from "../version.ts";
import { type BuiltInCommandEntry, builtInCommandEntries } from "./built-in-command-registry.ts";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help.ts";
import { emitResultLine } from "./compiled-runtime.ts";
import { resolveTopLevelAliases } from "./oclif/command-spec.ts";

const version = `@lando/core/${CORE_VERSION}`;

export const printRootHelp = (): void => {
  const visibleEntries = builtInCommandEntries.filter(({ spec }) => spec.hidden !== true);
  const namespaces = new Map<string, Array<BuiltInCommandEntry>>();
  const aliases: Array<readonly [string, string]> = [];
  for (const entry of visibleEntries) {
    const namespace = entry.spec.id.split(":", 1)[0] ?? entry.spec.namespace;
    const entries = namespaces.get(namespace) ?? [];
    entries.push(entry);
    namespaces.set(namespace, entries);
    for (const alias of entry.command.aliases ?? []) {
      if (!alias.startsWith("-")) aliases.push([alias, entry.spec.id]);
    }
  }

  const lines = [
    `Lando v4 core: runtime, planner, command registry, and library API.

VERSION
  ${version} ${process.platform}-${process.arch} node-${process.version}

USAGE
  $ lando [COMMAND]

TOPICS
  app   Operate on the current Lando app.
  apps  Discover and operate across Lando apps on the host.
  meta  Operate on Lando itself: config, plugins, host setup.

COMMANDS`,
  ];
  for (const [namespace, entries] of [...namespaces].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  ${namespace}`);
    for (const { spec } of entries) lines.push(`    ${spec.id.padEnd(30)} ${spec.summary}`);
  }
  lines.push("", "ALIASES");
  for (const [alias, canonicalId] of aliases.sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`  ${alias} -> ${canonicalId}`);
  }
  emitResultLine(lines.join("\n"));
};

export const printCommandHelp = (entry: BuiltInCommandEntry): void => {
  const { command, spec, status } = entry;
  const lines = [
    `${spec.description ?? spec.summary}

USAGE
  $ lando ${renderCommandUsage(spec.id, command)}

ALIASES
  ${[spec.id, ...resolveTopLevelAliases(spec)].join(", ")}`,
  ];
  if (status.kind === "deferred") {
    lines.push("", "STATUS", `  Planned for Lando ${status.plan.phase}.`);
  }
  lines.push(...renderCommandHelpFlags(command));
  emitResultLine(lines.join("\n"));
};
