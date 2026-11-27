import { type ExpressionNode, type ExpressionTemplate, expressionScopeMembers } from "@lando/sdk/expressions";
import type { ParsedPendingSite, ToolingTaskShape } from "@lando/sdk/schema";
import { readsServiceUrl } from "./service-url-reads.ts";

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

const placementPath = (path: readonly (string | number)[]): boolean =>
  (path.length === 1 && ["service", "user", "dir"].includes(String(path[0]))) ||
  (path.length === 3 && path[0] === "vars" && path[2] === "service") ||
  (path.length === 3 && path[0] === "cmds" && ["service", "user", "dir"].includes(String(path[2])));

/** Literal vars whose definitions read a public service URL, directly or through other literal vars. */
const serviceUrlVarNames = (sites: readonly ParsedPendingSite[]): ReadonlySet<string> => {
  const names = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const site of sites) {
      const name = String(site.path[1]);
      if (site.path[0] !== "vars" || site.path.length !== 2 || names.has(name)) continue;
      if (readsServiceUrl(site.template) || readsDynamicToolingVar(site.template, names)) {
        names.add(name);
        changed = true;
      }
    }
  }
  return names;
};

/** Placement resolves before the router is consulted, so no service, user, or dir may follow a URL. */
export const serviceUrlPlacementIssues = (sites: readonly ParsedPendingSite[]) => {
  const names = serviceUrlVarNames(sites);
  return sites
    .filter((site) => placementPath(site.path) && readsDynamicToolingVar(site.template, names))
    .map((site) => ({
      reason: "service-url-placement",
      rule: "landofile.tooling" as const,
      path: site.path,
      source: site.source,
      message: "A var that reads a public route fact cannot choose a task or step's service, user, or dir.",
      suggestion:
        "Read the route fact in a command, cmds step, env value, or var; choose service, user, and dir from literals or invocation input.",
    }));
};
