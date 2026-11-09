import { type ExpressionNode, type ExpressionTemplate, expressionScopeMembers } from "@lando/sdk/expressions";
import type { ParsedPendingSite, ToolingTaskShape } from "@lando/sdk/schema";
import { dynamicToolingNames, readsDynamicToolingVar } from "./tooling-dynamic-references.ts";

const DATA_SCOPES = ["flags", "args", "raw", "task", "event", "item", "key"] as const;
export const readsToolingData = (
  expression: ExpressionTemplate | ExpressionNode,
  names: ReadonlySet<string>,
): boolean =>
  DATA_SCOPES.some((scope) => {
    const reads = expressionScopeMembers(expression, scope);
    return !reads.analyzable || reads.members.size > 0;
  }) || readsDynamicToolingVar(expression, names);

/** Definitions retain their recorded ASTs; rendered text is never parsed again. */
export const toolingDataNames = (
  task: ToolingTaskShape,
  sites: readonly ParsedPendingSite[],
  overrides: Readonly<Record<string, unknown>> = {},
): ReadonlySet<string> => {
  const names = new Set([...dynamicToolingNames(task), ...Object.keys(overrides)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const site of sites) {
      const name = String(site.path[1]);
      if (site.path[0] === "vars" && !names.has(name) && readsToolingData(site.template, names)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
};
