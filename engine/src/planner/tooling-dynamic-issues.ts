import { dynamicToolingReferenceIssues, toolingInvocationIssues } from "@lando/landofile/compiled-sites";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import type { ResolvedLandofile } from "./event-set.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { toolingIssueSource } from "./tooling-provenance.ts";

export const toolingDynamicIssues = (
  resolution: ResolvedLandofile,
  sites: readonly ParsedPendingSite[],
): readonly PlannerIssue[] => {
  const { tasks: tooling, provenance } = resolution.toolingResolution;
  return enabledToolingEntries(tooling).flatMap(([name, task]) => {
    const taskSites = sites
      .filter((site) => site.path[0] === "tooling" && site.path[1] === name)
      .map((site) => ({ ...site, path: site.path.slice(2) }));
    return [
      ...dynamicToolingReferenceIssues(task, taskSites),
      ...toolingInvocationIssues(task, taskSites),
    ].map((issue) => {
      const source = toolingIssueSource(provenance, name, issue.path);
      return {
        ...issue,
        rule: "landofile.tooling" as const,
        path: ["tooling", name, ...issue.path],
        ...(source === undefined ? {} : { source }),
      };
    });
  });
};
