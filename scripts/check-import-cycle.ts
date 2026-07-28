import { resolve } from "node:path";

import { createModuleEdgeCache } from "./architecture/edges.ts";
import { createInventory } from "./architecture/inventory.ts";
import { createWorkspaceManifestReader } from "./architecture/manifests.ts";
import { type ImportCycleContext, analyzeImportCycles } from "./architecture/rules/import-cycle.ts";

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

export interface ImportCycleResult {
  readonly ok: boolean;
  readonly filesScanned: number;
  readonly cycles: ReadonlyArray<ImportCycle>;
}

interface CheckImportCycleOptions {
  readonly root: string;
}

export const checkImportCycle = async ({
  root: rootInput,
}: CheckImportCycleOptions): Promise<ImportCycleResult> => {
  const root = resolve(rootInput);
  const inventory = createInventory(root);
  const edges = createModuleEdgeCache();
  const manifests = createWorkspaceManifestReader(root, () => inventory.manifestFiles());
  const context: ImportCycleContext = {
    root,
    files: (selector) => inventory.files(selector),
    async moduleEdges(file) {
      return edges.moduleEdges(file.absolutePath, await Bun.file(file.absolutePath).text());
    },
    manifests: () => manifests.manifests(),
  };
  const analysis = await analyzeImportCycles(context);
  return {
    ok: analysis.cycles.length === 0,
    filesScanned: analysis.filesScanned,
    cycles: analysis.cycles,
  };
};

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const result = await checkImportCycle({ root });
  if (result.ok) {
    process.stdout.write(`Import cycle check passed (${result.filesScanned} production modules).\n`);
  } else {
    const details = result.cycles.flatMap((cycle, index) => [
      `Cycle ${index + 1}: ${cycle.modules.join(" -> ")}`,
      ...cycle.edges.map(
        (edge) => `  ${edge.from}:${edge.line} imports ${edge.to} via ${JSON.stringify(edge.specifier)}`,
      ),
    ]);
    process.stderr.write(
      `Import cycle check failed. Break each runtime dependency cycle:\n${details.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
