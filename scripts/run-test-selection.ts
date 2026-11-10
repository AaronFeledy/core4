#!/usr/bin/env bun
import { TEST_ROOT, collectTestFiles, resolveTestSelection } from "./test-selection-files.ts";
import { TEST_SELECTIONS, type TestSelection } from "./test-selections.ts";

export class TestSelectionError extends Error {
  constructor(
    readonly reason: "unknown" | "empty" | "runner",
    readonly id: string,
  ) {
    super(
      {
        unknown: `Unknown test selection "${id}"; see scripts/test-selections.ts.`,
        empty: `Test selection "${id}" resolved to zero files; check scripts/test-selections.ts.`,
        runner: `Test selection "${id}" uses the Go container builder, not the Bun runner.`,
      }[reason],
    );
  }
}

export const runTestSelection = async (
  id: string,
  options: {
    readonly root?: string;
    readonly selections?: readonly TestSelection[];
  } = {},
): Promise<number> => {
  const selections: readonly TestSelection[] = options.selections ?? TEST_SELECTIONS;
  const selection = selections.find((entry) => entry.id === id);
  if (selection === undefined) throw new TestSelectionError("unknown", id);
  if (selection.runner === "go") throw new TestSelectionError("runner", id);
  const root = options.root ?? TEST_ROOT;
  const files = resolveTestSelection(selection, await collectTestFiles(root));
  if (files.length === 0) throw new TestSelectionError("empty", id);
  console.error(`[test:selection] ${id}: ${files.length} files`);
  // Trees go to Bun as `./dir` so it keeps its own file order, as the workflow steps
  // this replaces did; files and globs are passed as the exact files they resolve to.
  const targets = selection.paths.flatMap((selector) =>
    selector.endsWith("/")
      ? [`./${selector.slice(0, -1)}`]
      : resolveTestSelection({ ...selection, paths: [selector] }, files).map((path) => `./${path}`),
  );
  return Bun.spawn(
    [
      process.execPath,
      ...(selection.noOrphans ? ["--no-orphans"] : []),
      "test",
      ...(selection.args ?? []),
      ...(selection.ignore ?? []).map((pattern) => `--path-ignore-patterns=${pattern}`),
      ...new Set(targets),
    ],
    { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  ).exited;
};

if (import.meta.main) {
  try {
    const [id, ...extra] = process.argv.slice(2);
    if (id === undefined || extra.length) throw new Error("usage: bun run test:selection <id>");
    process.exitCode = await runTestSelection(id);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
