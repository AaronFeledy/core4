import { inspectToolingTask } from "@lando/landofile/tooling-normalize";
import { Result } from "effect";
import { staticToolingLauncher } from "../tooling/launchers.ts";
import { planServicePrimary } from "./effective-events.ts";
import type { ResolvedLandofile } from "./event-set.ts";
import { pathIsBlocked } from "./landofile-scopes.ts";
import type { PlannerIssue } from "./resolved-validation.ts";
import { enabledToolingEntries } from "./tooling-composition.ts";
import { toolingIssueLocations, toolingIssueSource } from "./tooling-provenance.ts";

export const toolingDeclarationIssues = (resolution: ResolvedLandofile): readonly PlannerIssue[] => {
  const { tasks, provenance, launcherServices } = resolution.toolingResolution;
  const primary = resolution.services.find(({ name, resolution: service }) =>
    planServicePrimary(name, service.normalizedConfig.primary),
  )?.name;
  const blocked = resolution.blocked;
  return enabledToolingEntries(tasks).flatMap(([name, task]) => {
    if (pathIsBlocked(blocked, ["tooling", name])) return [];
    const inspection = inspectToolingTask(name, task);
    const launcher = Result.isSuccess(inspection)
      ? staticToolingLauncher(task, { services: launcherServices, primary })
      : undefined;
    const issues = Result.isFailure(inspection)
      ? inspection.failure
      : launcher !== undefined && Result.isFailure(launcher)
        ? launcher.failure
        : [];
    return issues.map((issue): PlannerIssue => {
      const source = toolingIssueSource(provenance, name, issue.path);
      return {
        ...issue,
        rule: "landofile.tooling",
        path: ["tooling", name, ...issue.path],
        ...(source === undefined ? {} : { source }),
        ...(issue.related === undefined
          ? {}
          : {
              related: toolingIssueLocations(
                provenance,
                name,
                issue.related.map((location) => location.path),
              ),
            }),
      };
    });
  });
};
