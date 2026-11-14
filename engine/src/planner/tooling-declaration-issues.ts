import { inspectToolingTask } from "@lando/landofile/tooling-normalize";
import { getLandofileValueSource } from "@lando/landofile/validation";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { Result } from "effect";
import { compileEffectiveTooling, toolingBeforeDefaults, toolingContributors } from "./effective-tooling.ts";
import type { HostShellResolution } from "./host-shell-issues.ts";
import type { PlannerIssue } from "./resolved-validation.ts";

/** Declaration checks are invocation refusals and lint findings, never planning admission. */
export const toolingDeclarationIssues = (resolution: HostShellResolution): readonly PlannerIssue[] => {
  const { landofile } = resolution;
  const services = resolution.services.map((entry) => ({
    name: entry.name,
    serviceTypeId: entry.serviceType.id,
    ...(entry.resolution.tooling === undefined ? {} : { tooling: entry.resolution.tooling }),
  }));
  const beforeDefaults = toolingBeforeDefaults({ landofile, services });
  const contributors = toolingContributors(services);
  return Object.entries(compileEffectiveTooling({ landofile, services })).flatMap(([name, task]) => {
    if (task.disabled === true) return [];
    const inspection = inspectToolingTask(name, task);
    if (Result.isSuccess(inspection)) return [];
    return inspection.failure.map((issue): PlannerIssue => {
      const path = ["tooling", name, ...issue.path];
      const [field, member] = issue.path;
      const winner = beforeDefaults[name];
      // Defaults merge env/vars by member; service/dir inherit only when absent on the winner.
      const inherited =
        (field === "env" &&
          typeof member === "string" &&
          !Object.hasOwn(winner?.env ?? {}, member) &&
          Object.hasOwn(landofile.toolingDefaults?.env ?? {}, member)) ||
        (field === "vars" &&
          typeof member === "string" &&
          !Object.hasOwn(winner?.vars ?? {}, member) &&
          Object.hasOwn(landofile.toolingDefaults?.vars ?? {}, member)) ||
        ((field === "service" || field === "dir") &&
          winner?.[field] === undefined &&
          landofile.toolingDefaults?.[field] !== undefined);
      const contributor = contributors.get(name);
      const sourcePath: ValidationIssuePath = inherited
        ? ["toolingDefaults", ...issue.path]
        : Object.hasOwn(landofile.tooling ?? {}, name) || contributor === undefined
          ? path
          : ["services", contributor.name, "type"];
      const source = getLandofileValueSource(landofile, sourcePath);
      return { ...issue, rule: "landofile.tooling", path, ...(source === undefined ? {} : { source }) };
    });
  });
};
