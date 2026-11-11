import { expressionScopeMembers } from "@lando/sdk/expressions";
import type { ParsedPendingSite, ToolingTaskShape } from "@lando/sdk/schema";
import { suggestionForUnknownKey } from "@lando/sdk/schema";
import { rawPlacementRefused } from "./tooling-raw-placement.ts";

export const toolingInvocationIssues = (task: ToolingTaskShape, sites: readonly ParsedPendingSite[]) =>
  sites.flatMap((site) => {
    const issues: {
      readonly path: typeof site.path;
      readonly source: typeof site.source;
      readonly message: string;
      readonly suggestion: string;
    }[] = [];
    for (const group of ["flags", "args"] as const) {
      const declared = Object.keys(task[group] ?? {});
      for (const name of expressionScopeMembers(site.template, group).members) {
        if (declared.includes(name)) continue;
        const suggestion = suggestionForUnknownKey(name, declared);
        issues.push({
          path: site.path,
          source: site.source,
          message: `Unknown tooling input ${group}.${name}.`,
          suggestion: `${suggestion ?? `Declare ${group}.${name} on this task.`} Correct the reference at ${site.source.path.join(".")}.`,
        });
      }
    }
    const raw = expressionScopeMembers(site.template, "raw");
    if (raw.analyzable && raw.members.size === 0) return issues;
    if (Object.keys(task.flags ?? {}).length > 0 || Object.keys(task.args ?? {}).length > 0)
      issues.push({
        path: site.path,
        source: site.source,
        message: "raw is unavailable on tasks with declared flags or args.",
        suggestion: `Use flags.<name> or args.<name> at ${site.source.path.join(".")}, or remove the input declarations to accept a raw tail.`,
      });
    else if (rawPlacementRefused(site))
      issues.push({
        path: site.path,
        source: site.source,
        message: "raw must occupy a whole unquoted argument word.",
        suggestion: `Move raw at ${site.source.path.join(".")} after the executable, outside quotes, redirections, and adjacent text; in argv form use a whole {{ raw }} element.`,
      });
    return issues;
  });

export const consumedToolingInputs = (task: ToolingTaskShape, sites: readonly ParsedPendingSite[]) => {
  const flags = new Set<string>();
  const args = new Set<string>();
  let raw = false;
  for (const site of sites) {
    for (const group of ["flags", "args"] as const) {
      const read = expressionScopeMembers(site.template, group);
      for (const name of read.analyzable ? read.members : Object.keys(task[group] ?? {}))
        (group === "flags" ? flags : args).add(name);
    }
    const read = expressionScopeMembers(site.template, "raw");
    raw ||= !read.analyzable || read.members.size > 0;
  }
  const target = (service: string | undefined) => {
    if (service?.startsWith(":") && service !== ":host") flags.add(service.slice(1));
  };
  target(task.service);
  for (const step of task.cmds ?? []) if (typeof step !== "string") target(step.service);
  for (const variable of Object.values(task.vars ?? {}))
    if (typeof variable === "object") target(variable.service);
  return { flags, args, raw };
};
