import { inspectToolingTask } from "@lando/landofile/tooling-normalize";
import { Result } from "effect";
import type { HostShellResolution } from "./host-shell-issues.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { toolingIssueSource } from "./tooling-provenance.ts";

export const toolingDeclarationIssues = (resolution: HostShellResolution): readonly PlannerIssue[] => {
  const { tasks, provenance } = resolution.toolingResolution;
  return enabledToolingEntries(tasks).flatMap(([name, task]) => {
    const inspection = inspectToolingTask(name, task);
    if (Result.isSuccess(inspection)) return [];
    return inspection.failure.map((issue): PlannerIssue => {
      const source = toolingIssueSource(provenance, name, issue.path);
      return {
        ...issue,
        rule: "landofile.tooling",
        path: ["tooling", name, ...issue.path],
        ...(source === undefined ? {} : { source }),
      };
    });
  });
};
