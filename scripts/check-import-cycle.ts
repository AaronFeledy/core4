import { resolve } from "node:path";

import { runRuleSet } from "./boundary/engine.ts";
import { type ImportCycleResult, createImportCycleRule } from "./boundary/rules/import-cycle.ts";

export type {
  ImportCycle,
  ImportCycleEdge,
  ImportCycleResult,
} from "./boundary/rules/import-cycle.ts";

interface CheckImportCycleOptions {
  readonly root: string;
}

export const checkImportCycle = async ({
  root: rootInput,
}: CheckImportCycleOptions): Promise<ImportCycleResult> => {
  let result: ImportCycleResult | undefined;
  const rule = createImportCycleRule((observed) => {
    result = observed;
  });
  await runRuleSet([rule], resolve(rootInput));
  if (result === undefined) throw new TypeError("Import cycle rule produced no analysis result");
  return result;
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
