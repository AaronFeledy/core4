import { dirname, extname, join, relative, resolve } from "node:path";

import type { Diagnostic, Rule, RuleContext, WorkspaceManifest } from "../types.ts";

export interface ImportCycleEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly specifier: string;
}

export interface ImportCycle {
  readonly modules: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<ImportCycleEdge>;
}

export interface ImportCycleAnalysis {
  readonly filesScanned: number;
  readonly cycles: ReadonlyArray<ImportCycle>;
}

export type ImportCycleContext = Pick<RuleContext, "root" | "files" | "moduleEdges" | "manifests">;

interface WorkspacePackage {
  readonly directory: string;
  readonly exports: ReadonlyMap<string, string>;
}

interface RuntimeEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly specifier: string;
}

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runtimeTarget = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!isJsonObject(value)) return undefined;
  if (typeof value.import === "string") return value.import;
  return typeof value.types === "string" ? value.types : undefined;
};

const toWorkspacePackage = (manifest: WorkspaceManifest): readonly [string, WorkspacePackage] => {
  const targets = new Map<string, string>();
  const rootTarget = runtimeTarget(manifest.exports);
  if (rootTarget !== undefined) targets.set(".", rootTarget);
  if (isJsonObject(manifest.exports)) {
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      if (subpath !== "." && !subpath.startsWith("./")) continue;
      const target = runtimeTarget(value);
      if (target !== undefined) targets.set(subpath, target);
    }
  }
  if (!targets.has(".")) targets.set(".", "./src/index");
  return [manifest.packageName, { directory: manifest.packageRoot, exports: targets }];
};

const resolveFile = (base: string, files: ReadonlySet<string>): string | undefined => {
  const extension = extname(base);
  const candidates = [base];
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    const stem = base.slice(0, -extension.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  } else if (extension === "") {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`);
    candidates.push(
      join(base, "index.ts"),
      join(base, "index.tsx"),
      join(base, "index.mts"),
      join(base, "index.cts"),
    );
  }
  return candidates.find((candidate) => files.has(candidate));
};

const resolveWorkspaceSpecifier = (
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): string | undefined => {
  for (const [name, pkg] of packages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const target = pkg.exports.get(subpath);
    return target === undefined ? undefined : resolve(pkg.directory, target);
  }
  return undefined;
};

const stronglyConnectedComponents = (
  files: ReadonlyArray<string>,
  graph: ReadonlyMap<string, ReadonlyArray<RuntimeEdge>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const components: string[][] = [];

  const visit = (file: string): void => {
    const index = nextIndex++;
    indices.set(file, index);
    lowlinks.set(file, index);
    stack.push(file);
    stacked.add(file);

    for (const edge of graph.get(file) ?? []) {
      const targetIndex = indices.get(edge.to);
      if (targetIndex === undefined) {
        visit(edge.to);
        const targetLowlink = lowlinks.get(edge.to);
        const fileLowlink = lowlinks.get(file);
        if (targetLowlink !== undefined && fileLowlink !== undefined) {
          lowlinks.set(file, Math.min(fileLowlink, targetLowlink));
        }
      } else if (stacked.has(edge.to)) {
        const fileLowlink = lowlinks.get(file);
        if (fileLowlink !== undefined) lowlinks.set(file, Math.min(fileLowlink, targetIndex));
      }
    }

    if (lowlinks.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      stacked.delete(member);
      component.push(member);
      if (member === file) break;
    }
    components.push(component.sort());
  };

  for (const file of files) if (!indices.has(file)) visit(file);
  return components;
};

const toRelative = (root: string, path: string): string => relative(root, path).replaceAll("\\", "/");

export const analyzeImportCycles = async (context: ImportCycleContext): Promise<ImportCycleAnalysis> => {
  const inventoryFiles = await context.files("workspace-runtime-sources");
  const files = inventoryFiles.map(({ absolutePath }) => absolutePath);
  const fileSet = new Set(files);
  const packages = new Map((await context.manifests()).map(toWorkspacePackage));
  const graph = new Map<string, ReadonlyArray<RuntimeEdge>>();

  await Promise.all(
    inventoryFiles.map(async (file) => {
      const runtimeEdges: RuntimeEdge[] = [];
      for (const edge of await context.moduleEdges(file)) {
        if (edge.typeOnly) continue;
        const base = edge.specifier.startsWith(".")
          ? resolve(dirname(file.absolutePath), edge.specifier)
          : resolveWorkspaceSpecifier(edge.specifier, packages);
        const target = base === undefined ? undefined : resolveFile(base, fileSet);
        if (target !== undefined) {
          runtimeEdges.push({
            from: file.absolutePath,
            to: target,
            line: edge.line,
            specifier: edge.specifier,
          });
        }
      }
      graph.set(
        file.absolutePath,
        runtimeEdges.toSorted((left, right) => left.to.localeCompare(right.to) || left.line - right.line),
      );
    }),
  );

  const cycles = stronglyConnectedComponents(files, graph)
    .filter((component) => {
      const first = component[0];
      return (
        component.length > 1 ||
        (first !== undefined && graph.get(first)?.some((edge) => edge.to === first) === true)
      );
    })
    .map((component) => {
      const members = new Set(component);
      const edges = component.flatMap((file) =>
        (graph.get(file) ?? []).filter((edge) => members.has(edge.to)),
      );
      return {
        modules: component.map((file) => toRelative(context.root, file)),
        edges: edges.map((edge) => ({
          from: toRelative(context.root, edge.from),
          to: toRelative(context.root, edge.to),
          line: edge.line,
          specifier: edge.specifier,
        })),
      } satisfies ImportCycle;
    })
    .sort((left, right) => left.modules.join("\0").localeCompare(right.modules.join("\0")));

  return { filesScanned: files.length, cycles };
};

const cycleDiagnostic = (cycle: ImportCycle, index: number): Diagnostic => ({
  ruleId: "import-cycle",
  file: cycle.modules[0] ?? `cycle-${index + 1}`,
  message: cycle.modules.join(" -> "),
  detail: cycle.edges.map(
    (edge) => `${edge.from}:${edge.line} imports ${edge.to} via ${JSON.stringify(edge.specifier)}`,
  ),
});

export const importCycleRule: Rule = {
  id: "import-cycle",
  title: "Import cycle",
  failureHeadline: "Import cycle check failed. Break each runtime dependency cycle:",
  async run(context) {
    const analysis = await analyzeImportCycles(context);
    return analysis.cycles.map(cycleDiagnostic);
  },
};
