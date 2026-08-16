import { resolve } from "node:path";

import { writeFormattedOutput } from "./_codegen-output.ts";
import {
  type DetachedTestBaselineEdge,
  type DetachedTestsBaseline,
  collectTestTierViolations,
  readDetachedTestsBaseline,
} from "./boundary/rules/package-dag-test.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BASELINE_NOTE =
  "Shrink-only migration ledger for detached test entrypoints and packages without tests. Regenerate with bun run scripts/generate-detached-tests-baseline.ts.";

type GenerationOptions = {
  readonly allowGrowth: boolean;
  readonly dryRun: boolean;
};

type GenerationSummary = {
  readonly addedPackages: number;
  readonly addedTestTierEdges: number;
  readonly packagesWithoutTests: number;
  readonly removedPackages: number;
  readonly removedTestTierEdges: number;
  readonly testTierEdges: number;
};

export class DetachedTestsBaselineGrowthError extends Error {
  override readonly name = "DetachedTestsBaselineGrowthError";

  constructor(readonly summary: GenerationSummary) {
    super(
      `Detached-tests baseline growth refused: ${summary.addedTestTierEdges} test-tier edge additions and ${summary.addedPackages} package additions. Re-run with --allow-growth only for an intentional migration reset.`,
    );
  }
}

const edgeKey = (edge: DetachedTestBaselineEdge): string => `${edge.file}\0${edge.specifier}`;

const sortedUniqueEdges = (
  edges: readonly DetachedTestBaselineEdge[],
): readonly DetachedTestBaselineEdge[] => {
  const byKey = new Map(edges.map((edge) => [edgeKey(edge), { file: edge.file, specifier: edge.specifier }]));
  return [...byKey.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
};

const sortedUnique = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

export const generateDetachedTestsBaseline = async (
  root: string,
  options: GenerationOptions,
): Promise<GenerationSummary> => {
  const [current, live] = await Promise.all([
    readDetachedTestsBaseline(root),
    collectTestTierViolations(root),
  ]);
  const next: DetachedTestsBaseline = {
    note: BASELINE_NOTE,
    testTierEdges: sortedUniqueEdges(live.testTierEdges),
    packagesWithoutTests: sortedUnique(live.packagesWithoutTests.map((entry) => entry.directory)),
  };
  const currentEdges = new Set(current.testTierEdges.map(edgeKey));
  const nextEdges = new Set(next.testTierEdges.map(edgeKey));
  const currentPackages = new Set(current.packagesWithoutTests);
  const nextPackages = new Set(next.packagesWithoutTests);
  const summary = {
    addedPackages: next.packagesWithoutTests.filter((directory) => !currentPackages.has(directory)).length,
    addedTestTierEdges: next.testTierEdges.filter((edge) => !currentEdges.has(edgeKey(edge))).length,
    packagesWithoutTests: next.packagesWithoutTests.length,
    removedPackages: current.packagesWithoutTests.filter((directory) => !nextPackages.has(directory)).length,
    removedTestTierEdges: current.testTierEdges.filter((edge) => !nextEdges.has(edgeKey(edge))).length,
    testTierEdges: next.testTierEdges.length,
  } satisfies GenerationSummary;

  if ((summary.addedTestTierEdges > 0 || summary.addedPackages > 0) && !options.allowGrowth) {
    throw new DetachedTestsBaselineGrowthError(summary);
  }
  if (!options.dryRun) {
    await writeFormattedOutput(
      resolve(root, "scripts/boundary/detached-tests-baseline.json"),
      `${JSON.stringify(next, null, 2)}\n`,
    );
  }
  return summary;
};

const parseOptions = (args: readonly string[]): GenerationOptions => {
  const unknown = args.find((argument) => argument !== "--allow-growth" && argument !== "--dry-run");
  if (unknown !== undefined) throw new TypeError(`Unknown argument: ${unknown}`);
  return { allowGrowth: args.includes("--allow-growth"), dryRun: args.includes("--dry-run") };
};

const main = async (args: readonly string[]): Promise<void> => {
  const options = parseOptions(args);
  const summary = await generateDetachedTestsBaseline(REPO_ROOT, options);
  const action = options.dryRun ? "dry run" : "wrote baseline";
  process.stdout.write(
    `[generate-detached-tests-baseline] ${action}: ${summary.testTierEdges} test-tier edges, ${summary.packagesWithoutTests} packages without tests; ${summary.addedTestTierEdges + summary.addedPackages} additions, ${summary.removedTestTierEdges + summary.removedPackages} removals\n`,
  );
};

if (import.meta.main) await main(process.argv.slice(2));
