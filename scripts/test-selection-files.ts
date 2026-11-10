import { resolve } from "node:path";
import { type TestSelection, selectionMatches } from "./test-selections.ts";

export const TEST_ROOT = resolve(import.meta.dirname, "..");
export const normalizeTestPath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//u, "");
export const isBunTest = (path: string): boolean =>
  /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/u.test(path);
export const isIntegrationTest = (path: string): boolean =>
  /\.integration[._](?:test|spec)\.[cm]?[jt]sx?$/u.test(path);
export const isTestFile = (path: string): boolean => isBunTest(path) || path.endsWith("_test.go");

export const collectTestFiles = async (root = TEST_ROOT): Promise<readonly string[]> => {
  const child = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ls-files failed (exit ${code}): ${stderr}`);
  const paths = [...new Set(stdout.split("\0").map(normalizeTestPath).filter(isTestFile))].sort();
  const existing = await Promise.all(
    paths.map(async (path) => ((await Bun.file(resolve(root, path)).exists()) ? path : undefined)),
  );
  return existing.filter((path): path is string => path !== undefined);
};

export const resolveTestSelection = (selection: TestSelection, files: readonly string[]): readonly string[] =>
  [
    ...new Set(
      files.filter(
        (path) =>
          (selection.runner === "go" ? path.endsWith("_test.go") : isBunTest(path)) &&
          selectionMatches(selection, path),
      ),
    ),
  ].sort();
