import { relative } from "node:path";

import { type RuntimeEdge, collectManifests, stronglyConnectedComponents } from "../graph.ts";
import type { BoundaryRule, ProgramContext, Violation } from "../types.ts";
import { ALL_PACKAGE_SOURCE_ROOTS, NON_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

interface PackageDagBoundaryRule extends BoundaryRule {
  readonly alwaysAllowedPackages: readonly string[];
}

interface PluginPackage {
  readonly name: string;
  readonly sourcePrefix: string;
  readonly dependencies: ReadonlySet<string>;
}

interface PluginEdge extends RuntimeEdge {
  readonly violation: Violation;
}

const PACKAGE_DAG_DATA = {
  scope: {
    roots: ALL_PACKAGE_SOURCE_ROOTS,
    extensions: [".ts"],
    excludePathSegments: ["test"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: ["core/src/plugins/generated/"] },
  alwaysAllowedPackages: ["@lando/sdk", "@lando/container-runtime", "@lando/paths", "@lando/state-store"],
} as const;

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

const packageMatches = (specifier: string, packageName: string): boolean =>
  specifier === packageName || specifier.startsWith(`${packageName}/`);

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readPluginPackage = async (manifest: string, root: string): Promise<PluginPackage> => {
  const parsed: unknown = JSON.parse(await Bun.file(manifest).text());
  if (!isJsonObject(parsed) || typeof parsed.name !== "string") {
    throw new TypeError(`Invalid plugin package manifest: ${manifest}`);
  }
  const relativeManifest = normalizePath(relative(root, manifest));
  const dependencies = isJsonObject(parsed.dependencies)
    ? new Set(Object.keys(parsed.dependencies))
    : new Set<string>();
  return {
    name: parsed.name,
    sourcePrefix: relativeManifest.replace(/package\.json$/u, "src/"),
    dependencies,
  };
};

const checkProgram = async (context: ProgramContext): Promise<void> => {
  const manifests = (await collectManifests(context.root)).filter((manifest) =>
    /^plugins\/[^/]+\/package\.json$/u.test(normalizePath(relative(context.root, manifest))),
  );
  const packages = await Promise.all(manifests.map((manifest) => readPluginPackage(manifest, context.root)));
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
      if (packageMatches(edge.specifier, "@lando/core")) {
        report(violation);
        continue;
      }
      if (
        PACKAGE_DAG_DATA.alwaysAllowedPackages.some((packageName) =>
          packageMatches(edge.specifier, packageName),
        )
      ) {
        continue;
      }
      const target = packages.find((candidate) => packageMatches(edge.specifier, candidate.name));
      if (target === undefined || target.name === owner.name) continue;
      pluginEdges.push({
        from: owner.name,
        to: target.name,
        line: edge.line,
        specifier: edge.specifier,
        violation,
      });
      if (!owner.dependencies.has(target.name)) report(violation);
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
      if (!packages.some((candidate) => packageMatches(edge.specifier, candidate.name))) continue;
      report({ file: file.relativePath, line: edge.line, detail: edge.specifier });
    }
  }

  for (const violation of violations.values())
    context.report(violation.file, violation.line, violation.detail);
};

export const packageDagRule = {
  id: "package-dag",
  ...PACKAGE_DAG_DATA,
  passMessage: "Package DAG check passed.",
  failureHeadline: "Package DAG check failed. Fix package dependency direction:",
  onProgram: checkProgram,
} satisfies PackageDagBoundaryRule;
