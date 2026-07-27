import type { Diagnostic, InventoryFile, Rule, WorkspaceManifest } from "../types.ts";

interface PluginPackage {
  readonly name: string;
  readonly sourcePrefix: string;
  readonly dependencies: ReadonlySet<string>;
}

interface PluginEdge {
  readonly source: string;
  readonly target: string;
  readonly violation: Diagnostic;
}

const ALWAYS_ALLOWED = ["@lando/sdk", "@lando/container-runtime"] as const;

const isProductionTypeScript = (file: InventoryFile): boolean =>
  file.relativePath.endsWith(".ts") &&
  !file.relativePath.endsWith(".test.ts") &&
  !file.relativePath.split("/").includes("test");

const packageMatches = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const toPluginPackage = (manifest: WorkspaceManifest): PluginPackage | undefined =>
  /^plugins\/[^/]+$/u.test(manifest.relativeRoot)
    ? {
        name: manifest.packageName,
        sourcePrefix: `${manifest.relativeRoot}/src/`,
        dependencies: new Set(manifest.dependencies),
      }
    : undefined;

const reaches = (start: string, goal: string, graph: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
  const pending = [start];
  const visited = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (current === goal) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
};

const violationKey = (violation: Diagnostic): string =>
  `${violation.file}\0${violation.line ?? 0}\0${violation.message}`;

const sortDiagnostics = (diagnostics: ReadonlyArray<Diagnostic>): ReadonlyArray<Diagnostic> =>
  diagnostics.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.message.localeCompare(right.message),
  );

export const packageDagRule: Rule = {
  id: "package-dag",
  title: "Package DAG",
  failureHeadline: "Package DAG check failed. Fix package dependency direction:",
  async run(context) {
    const files = await context.files("workspace-runtime-sources");
    const packages = (await context.manifests())
      .map(toPluginPackage)
      .filter((pkg): pkg is PluginPackage => pkg !== undefined);
    const violations = new Map<string, Diagnostic>();
    const pluginEdges: PluginEdge[] = [];

    for (const file of files.filter(
      (candidate) =>
        /^plugins\/[^/]+\/src\//u.test(candidate.relativePath) && isProductionTypeScript(candidate),
    )) {
      const owner = packages.find((pkg) => file.relativePath.startsWith(pkg.sourcePrefix));
      if (owner === undefined) continue;
      for (const edge of await context.moduleEdges(file)) {
        const violation = {
          ruleId: "package-dag",
          file: file.relativePath,
          line: edge.line,
          message: edge.specifier,
        } satisfies Diagnostic;
        if (packageMatches(edge.specifier, "@lando/core")) {
          violations.set(violationKey(violation), violation);
          continue;
        }
        if (ALWAYS_ALLOWED.some((name) => packageMatches(edge.specifier, name))) continue;
        const target = packages.find((pkg) => packageMatches(edge.specifier, pkg.name));
        if (target === undefined || target.name === owner.name) continue;
        pluginEdges.push({ source: owner.name, target: target.name, violation });
        if (!owner.dependencies.has(target.name)) violations.set(violationKey(violation), violation);
      }
    }

    const graph = new Map<string, Set<string>>();
    for (const edge of pluginEdges) {
      const targets = graph.get(edge.source) ?? new Set<string>();
      targets.add(edge.target);
      graph.set(edge.source, targets);
    }
    for (const edge of pluginEdges) {
      if (reaches(edge.target, edge.source, graph)) {
        violations.set(violationKey(edge.violation), edge.violation);
      }
    }

    for (const file of files.filter(
      (candidate) => candidate.relativePath.startsWith("core/src/") && isProductionTypeScript(candidate),
    )) {
      for (const edge of await context.moduleEdges(file)) {
        if (!packages.some((pkg) => packageMatches(edge.specifier, pkg.name))) continue;
        const violation = {
          ruleId: "package-dag",
          file: file.relativePath,
          line: edge.line,
          message: edge.specifier,
        } satisfies Diagnostic;
        violations.set(violationKey(violation), violation);
      }
    }

    return sortDiagnostics([...violations.values()]);
  },
};
