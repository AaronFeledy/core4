import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface PathsBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

export interface PathsBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<PathsBoundaryOffender>;
}

interface CheckPathsBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

export const checkPathsBoundary = async (
  options: CheckPathsBoundaryOptions = {},
): Promise<PathsBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["paths-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics.map(({ file, line, message }) => ({
    file: resolve(root, file),
    line: line ?? 1,
    snippet: message,
  }));

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: PathsBoundaryOffender): string =>
  `${toRepoRelative(root, offender.file)}:${offender.line}: ${offender.snippet}`;

if (import.meta.main) {
  const result = await checkPathsBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Paths boundary check passed.\n");
  } else {
    process.stderr.write(
      `Paths boundary check failed. Hand-rolled root joins must use @lando/core/paths (makeLandoPaths) or PathsService.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
