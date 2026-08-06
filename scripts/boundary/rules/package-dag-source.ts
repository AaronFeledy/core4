import { type RuntimeEdge, stronglyConnectedComponents } from "../graph.ts";
import type { ProgramContext, Violation } from "../types.ts";
import { NON_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";
import {
  WORKSPACE_PACKAGE_NAMES,
  type WorkspaceManifest,
  isWorkspaceRuntimeTargetAllowed,
  packageMatches,
} from "./package-dag-policy.ts";

interface PluginSourcePackage {
  readonly name: string;
  readonly sourcePrefix: string;
  readonly dependencies: ReadonlySet<string>;
}

interface PluginEdge extends RuntimeEdge {
  readonly violation: Violation;
}

const escapesNamedPackage = (specifier: string): boolean =>
  !specifier.startsWith(".") && specifier.replaceAll("\\", "/").split("/").includes("..");

export const checkPackageSourceEdges = async (
  context: ProgramContext,
  manifests: readonly WorkspaceManifest[],
): Promise<void> => {
  const packages: readonly PluginSourcePackage[] = manifests
    .filter((manifest) => /^plugins\/[^/]+\/package\.json$/u.test(manifest.path))
    .map((manifest) => ({
      name: manifest.name,
      sourcePrefix: manifest.path.replace(/package\.json$/u, "src/"),
      dependencies: new Set(manifest.dependencies),
    }));
  const violations = new Map<string, Violation>();
  const pluginEdges: PluginEdge[] = [];
  const report = (violation: Violation): void => {
    violations.set(`${violation.file}\0${violation.line}\0${violation.detail}`, violation);
  };

  for (const file of context.files) {
    const owner = packages.find((candidate) => file.relativePath.startsWith(candidate.sourcePrefix));
    if (owner === undefined) continue;
    for (const edge of await context.edges(file)) {
      const violation = { file: file.relativePath, line: edge.line, detail: edge.specifier };
      if (escapesNamedPackage(edge.specifier)) {
        report(violation);
        continue;
      }
      const target = packages.find((candidate) => packageMatches(edge.specifier, candidate.name));
      const declaredTarget = WORKSPACE_PACKAGE_NAMES.find((packageName) =>
        packageMatches(edge.specifier, packageName),
      );
      if (target?.name === owner.name || declaredTarget === owner.name) continue;
      if (target !== undefined) {
        pluginEdges.push({
          from: owner.name,
          to: target.name,
          line: edge.line,
          specifier: edge.specifier,
          violation,
        });
        if (!owner.dependencies.has(target.name)) report(violation);
      }
      if (declaredTarget !== undefined && !isWorkspaceRuntimeTargetAllowed(owner.name, declaredTarget)) {
        report(violation);
      }
    }
  }

  const graph = new Map<string, RuntimeEdge[]>();
  for (const edge of pluginEdges) {
    const outgoing = graph.get(edge.from) ?? [];
    outgoing.push(edge);
    graph.set(edge.from, outgoing);
  }
  const componentByPackage = new Map<string, number>();
  stronglyConnectedComponents(
    packages.map((pluginPackage) => pluginPackage.name),
    graph,
  ).forEach((component, index) => {
    for (const packageName of component) componentByPackage.set(packageName, index);
  });
  for (const edge of pluginEdges) {
    const sourceComponent = componentByPackage.get(edge.from);
    if (sourceComponent !== undefined && sourceComponent === componentByPackage.get(edge.to)) {
      report(edge.violation);
    }
  }

  for (const file of context.files) {
    if (!NON_PLUGIN_SOURCE_ROOTS.some((root) => file.relativePath.startsWith(`${root}/`))) continue;
    for (const edge of await context.edges(file)) {
      if (
        !escapesNamedPackage(edge.specifier) &&
        !packages.some((candidate) => packageMatches(edge.specifier, candidate.name))
      ) {
        continue;
      }
      report({ file: file.relativePath, line: edge.line, detail: edge.specifier });
    }
  }

  for (const violation of violations.values()) {
    context.report(violation.file, violation.line, violation.detail);
  }
};
