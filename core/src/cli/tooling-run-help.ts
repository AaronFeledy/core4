import type { ToolingRunSummary, ToolingRunTarget } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "./diagnostic-text";

const targetText = (target: ToolingRunTarget): string => {
  switch (target.kind) {
    case "host":
      return "on the host";
    case "service":
      return `in ${escapeDiagnosticText(target.name)}`;
    case "flag":
      return `in the service named by --${escapeDiagnosticText(target.flag)}`;
    case "primary":
      return "in the primary service";
    case "dynamic":
      return "in a dynamically selected service";
    default:
      return target satisfies never;
  }
};

export const toolingRunHelp = (runs: ToolingRunSummary): string => {
  switch (runs.kind) {
    case "script":
      return `Runs ${escapeDiagnosticText(runs.path)} on the host.`;
    case "commands": {
      const targets = runs.targets.map(targetText);
      const allInServices = targets.every((target) => target.startsWith("in "));
      const places = allInServices ? targets.map((target) => target.slice(3)) : targets;
      const location =
        places.length < 3 ? places.join(" and ") : `${places.slice(0, -1).join(", ")}, and ${places.at(-1)}`;
      let command = `${runs.steps} commands`;
      if (runs.steps === 1) {
        command = runs.program === undefined ? "a command" : `\`${escapeDiagnosticText(runs.program)}\``;
      }
      return `Runs ${command} ${allInServices ? "in " : ""}${location}.`;
    }
    default:
      return runs satisfies never;
  }
};
