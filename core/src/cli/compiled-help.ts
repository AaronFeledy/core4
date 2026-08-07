/** Cold-path help adapters avoid loading OCLIF. */
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help";
import { renderColdRootHelp } from "./cold-path-output";
import { emitResultLine } from "./compiled-runtime";
import { resolveTopLevelAliases } from "./oclif/command-spec";

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
