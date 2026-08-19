/** Cold-path help adapters avoid loading OCLIF. */
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { renderCommandHelpFlags, renderCommandUsage } from "./cli-help";
import { renderColdRootHelp } from "./cold-path-output";
import { emitResultLine } from "./compiled-runtime";
import { resolveTopLevelAliases } from "./spec/command-spec";

export const printRootHelp = (activeAliases?: ReadonlyArray<readonly [string, string]>): void =>
  emitResultLine(renderColdRootHelp(activeAliases));

export const printCommandHelp = (entry: BuiltInCommandEntry): void => {
  const { spec, status } = entry;
  const lines = [
    `${spec.summary}

USAGE
  $ lando ${renderCommandUsage(spec.id, spec)}

ALIASES
  ${[spec.id, ...resolveTopLevelAliases(spec)].join(", ")}`,
  ];
  if (status.kind === "deferred") {
    lines.push("", "STATUS", `  Planned for Lando ${status.plan.phase}.`);
  }
  lines.push(...renderCommandHelpFlags(spec));
  emitResultLine(lines.join("\n"));
};
