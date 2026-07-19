/**
 * Compiled-CLI help rendering for the root command list and per-command usage.
 *
 * The compiled `$bunfs` dispatch path renders help without OCLIF, so these
 * builders format the top-level topic/command listing and a single command's
 * usage/aliases/flags directly from the compiled command table.
 */
import { CORE_VERSION } from "../version.ts";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help.ts";
import { type CompiledCommand, commandEntries, commandName } from "./compiled-argv.ts";
import { emitResultLine } from "./compiled-runtime.ts";

const version = `@lando/core/${CORE_VERSION}`;

export const printRootHelp = (): void => {
  const lines = [
    `Lando v4 core: runtime, planner, OCLIF adapter, and library API.

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
  for (const [id, command] of commandEntries) {
    const name = commandName(id, command);
    if (!name.includes(":")) {
      lines.push(`  ${name.padEnd(22)} ${command.description ?? ""}`);
    }
  }
  emitResultLine(lines.join("\n"));
};

export const printCommandHelp = (id: string, command: CompiledCommand): void => {
  const lines = [
    `${command.description ?? command.summary ?? id}

USAGE
  $ lando ${renderCommandUsage(id, command)}

ALIASES
  ${[id, ...(command.aliases ?? [])].join(", ")}`,
  ];
  lines.push(...renderCommandHelpFlags(command));
  emitResultLine(lines.join("\n"));
};
