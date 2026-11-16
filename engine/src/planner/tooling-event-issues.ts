import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { suggestionForUnknownKey } from "@lando/sdk/schema";
import { reservedToolingNameConflict } from "../operations/reserved-aliases.ts";
import { reservedEventCollisions, validEventNames } from "./event-names.ts";
import type { ResolvedLandofile } from "./event-set.ts";
import { type PlannerIssue, attributePlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { toolingIssueSource } from "./tooling-provenance.ts";

export const toolingAndEventIssues = (resolution: ResolvedLandofile): ReadonlyArray<PlannerIssue> => {
  const { landofile } = resolution;
  const { tasks: effectiveTooling, provenance } = resolution.toolingResolution;
  const internal = new Set(getInternalToolingTasks(effectiveTooling));
  const issues: PlannerIssue[] = [];
  for (const [name] of enabledToolingEntries(effectiveTooling)) {
    if (internal.has(name)) continue;
    const serviceTypeId = provenance[name]?.serviceTypeId;
    const source = toolingIssueSource(provenance, name, []);
    const issue = (message: string, suggestion: string): PlannerIssue => ({
      rule: "landofile.tooling",
      path: ["tooling", name],
      message,
      suggestion,
      ...(source === undefined ? {} : { source }),
    });
    const conflict = reservedToolingNameConflict(name, serviceTypeId);
    if (conflict !== undefined) issues.push(issue(conflict.message, conflict.remediation));
    const collisions = reservedEventCollisions(name);
    if (collisions.length > 0) {
      const claimant = serviceTypeId === undefined ? "Tooling task" : `Service type ${serviceTypeId} task`;
      issues.push(
        issue(
          `${claimant} ${name} would bind ${collisions.join(" and ")}, which Lando reserves for its own app and remote sync events.`,
          serviceTypeId === undefined
            ? `Rename tooling task ${name}.`
            : `Set tooling.${name}: false in the Landofile to drop service type ${serviceTypeId}'s task, or redefine it under another name.`,
        ),
      );
    }
  }
  if (resolution.unavailable.size === 0) {
    const valid = validEventNames(effectiveTooling);
    const known = new Set(valid);
    for (const name of Object.keys(landofile.events ?? {})) {
      if (known.has(name)) continue;
      const suggestion = suggestionForUnknownKey(name, valid);
      issues.push(
        attributePlannerIssue(landofile, {
          rule: "landofile.event",
          path: ["events", name],
          message: `Unknown app event ${name}.`,
          suggestion: suggestion ?? `Use one of: ${valid.join(", ")}.`,
        }),
      );
    }
  }
  return issues;
};
