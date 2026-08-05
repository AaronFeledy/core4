/**
 * Compiled-CLI help rendering for the root command list and per-command usage.
 *
 * The compiled `$bunfs` dispatch path renders help without OCLIF, so these
 * builders format the top-level topic/command listing and a single command's
 * usage/aliases/flags directly from the built-in command registry.
 */
import type { BuiltInCommandEntry } from "./built-in-command-registry.ts";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help.ts";
import { renderColdRootHelp } from "./cold-path-output.ts";
import { emitResultLine } from "./compiled-runtime.ts";
import { resolveTopLevelAliases } from "./oclif/command-spec.ts";

export const printRootHelp = (): void => emitResultLine(renderColdRootHelp());

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
