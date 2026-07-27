import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface ManagedFileBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface ManagedFileBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<ManagedFileBoundaryOffender>;
}

interface CheckManagedFileBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkManagedFileBoundary = async (
  options: CheckManagedFileBoundaryOptions = {},
): Promise<ManagedFileBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["managed-file-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics
    .map((diagnostic): ManagedFileBoundaryOffender => {
      if (diagnostic.line === undefined) {
        throw new TypeError("Managed-file boundary diagnostic is missing a line number");
      }
      return {
        file: resolve(root, diagnostic.file),
        line: diagnostic.line,
        match: diagnostic.message,
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: ManagedFileBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkManagedFileBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Managed-file boundary check passed.\n");
  } else {
    process.stderr.write(
      `Managed-file boundary check failed. Host project-file ownership-marker/overwrite logic must route through ManagedFileService (core/src/managed-file/).\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
