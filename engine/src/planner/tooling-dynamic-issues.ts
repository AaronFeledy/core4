import { dynamicToolingReferenceIssues, toolingInvocationIssues } from "@lando/landofile/compiled-sites";
import type { ParsedPendingSite } from "@lando/sdk/schema";
import { compileEffectiveTooling } from "./effective-tooling.ts";
import type { ResolvedLandofile } from "./event-set.ts";
import type { PlannerIssue } from "./resolved-validation.ts";

export const toolingDynamicIssues = (
  resolution: ResolvedLandofile,
  sites: readonly ParsedPendingSite[],
): readonly PlannerIssue[] => {
  const tooling = compileEffectiveTooling({
    landofile: resolution.landofile,
    services: resolution.services.map((entry) => ({
      name: entry.name,
      serviceTypeId: entry.serviceType.id,
      ...(entry.resolution.tooling === undefined ? {} : { tooling: entry.resolution.tooling }),
    })),
  });
  return Object.entries(tooling).flatMap(([name, task]) => {
    const taskSites = sites
      .filter((site) => site.path[0] === "tooling" && site.path[1] === name)
      .map((site) => ({ ...site, path: site.path.slice(2) }));
    return [
      ...dynamicToolingReferenceIssues(task, taskSites),
      ...toolingInvocationIssues(task, taskSites),
    ].map((issue) => ({
      ...issue,
      rule: "landofile.tooling" as const,
      path: ["tooling", name, ...issue.path],
    }));
  });
};
