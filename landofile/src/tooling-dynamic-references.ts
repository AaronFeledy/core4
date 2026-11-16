import { type ExpressionNode, type ExpressionTemplate, expressionScopeMembers } from "@lando/sdk/expressions";
import type { ParsedPendingSite, ToolingTaskShape } from "@lando/sdk/schema";

export const dynamicToolingNames = (task: ToolingTaskShape): ReadonlySet<string> =>
  new Set(
    Object.entries(task.vars ?? {}).flatMap(([name, value]) => (typeof value === "object" ? [name] : [])),
  );

export const readsDynamicToolingVar = (
  expression: ExpressionTemplate | ExpressionNode,
  names: ReadonlySet<string>,
): boolean => {
  if (names.size === 0) return false;
  const reads = expressionScopeMembers(expression, "vars");
  return !reads.analyzable || [...reads.members].some((name) => names.has(name));
};

/** Target selection and var definitions must be independent of shell output. */
export const dynamicToolingReferenceIssues = (
  task: ToolingTaskShape,
  sites: readonly ParsedPendingSite[],
) => {
  const names = dynamicToolingNames(task);
  return sites
    .filter(
      (site) =>
        (site.path[0] === "vars" ||
          (site.path.length === 1 && ["service", "user", "dir"].includes(String(site.path[0])))) &&
        readsDynamicToolingVar(site.template, names),
    )
    .map((site) => ({
      reason: "dynamic-var-reference",
      rule: "landofile.tooling" as const,
      path: site.path,
      source: site.source,
      message: "Dynamic tooling vars cannot be read by var definitions or task-level service, user, or dir.",
      suggestion:
        "Use a literal or invocation input in this field; read shell-computed vars in commands or step overrides.",
    }));
};
