import { dirname, relative, resolve } from "node:path";

import {
  type RuntimeEdge,
  loadWorkspacePackages,
  resolveFile,
  resolveWorkspaceSpecifier,
  stronglyConnectedComponents,
} from "../graph.ts";
import type { BoundaryRule, ProgramContext } from "../types.ts";

export interface ImportCycleEdge {
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly specifier: string;
}

export interface ImportCycle {
  readonly modules: readonly string[];
  readonly edges: readonly ImportCycleEdge[];
}

export interface ImportCycleResult {
  readonly ok: boolean;
  readonly filesScanned: number;
  readonly cycles: readonly ImportCycle[];
}

type ImportCycleObserver = (result: ImportCycleResult) => void;

const toRelative = (root: string, path: string): string => relative(root, path).replaceAll("\\", "/");

const analyzeImportCycles = async (context: ProgramContext): Promise<ImportCycleResult> => {
  const packages = await loadWorkspacePackages(context.root);
  const files = context.files.map((file) => file.absolutePath);
  const fileSet = new Set(files);
  const graph = new Map<string, readonly RuntimeEdge[]>();

  await Promise.all(
    context.files.map(async (file) => {
      const runtimeEdges: RuntimeEdge[] = [];
      for (const edge of await context.edges(file)) {
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
        runtimeEdges.sort((left, right) => left.to.localeCompare(right.to) || left.line - right.line),
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
      };
    })
    .sort((left, right) => left.modules.join("\0").localeCompare(right.modules.join("\0")));

  return { ok: cycles.length === 0, filesScanned: files.length, cycles };
};

export const createImportCycleRule = (observe?: ImportCycleObserver): BoundaryRule => ({
  id: "import-cycle",
  scope: {
    roots: ["core/src", "sdk/src", "container-runtime/src", "plugins/*/src"],
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Import cycle check passed.",
  failureHeadline: "Import cycle check failed. Break each runtime dependency cycle:",
  onProgram: async (context) => {
    const result = await analyzeImportCycles(context);
    observe?.(result);
    for (const cycle of result.cycles) {
      for (const edge of cycle.edges) {
        context.report(edge.from, edge.line, `imports ${edge.to} via ${JSON.stringify(edge.specifier)}`);
      }
    }
  },
});

export const importCycleRule = createImportCycleRule();
