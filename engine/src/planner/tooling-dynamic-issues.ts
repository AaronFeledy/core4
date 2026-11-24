import {
  dynamicToolingReferenceIssues,
  serviceUrlPlacementIssues,
  toolingInvocationIssues,
} from "@lando/landofile/compiled-sites";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import type { ResolvedLandofile } from "./event-set.ts";
import { pathIsBlocked } from "./landofile-scopes.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { toolingIssueSource } from "./tooling-provenance.ts";

export const toolingDynamicIssues = (
  resolution: ResolvedLandofile,
  sites: readonly ParsedPendingSite[],
): readonly PlannerIssue[] => {
  const { tasks: tooling, provenance } = resolution.toolingResolution;
  const { blocked } = resolution;
  return enabledToolingEntries(tooling).flatMap(([name, task]) => {
    if (pathIsBlocked(blocked, ["tooling", name])) return [];
    const taskSites = sites
      .filter((site) => site.path[0] === "tooling" && site.path[1] === name)
      .map((site) => ({ ...site, path: site.path.slice(2) }));
    return [
      ...dynamicToolingReferenceIssues(task, taskSites),
      ...toolingInvocationIssues(task, taskSites),
      ...serviceUrlPlacementIssues(taskSites),
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
