import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface RedactionBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface RedactionBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<RedactionBoundaryOffender>;
}

interface CheckRedactionBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkRedactionBoundary = async (
  options: CheckRedactionBoundaryOptions = {},
): Promise<RedactionBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["redaction-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics
    .map((diagnostic): RedactionBoundaryOffender => {
      if (diagnostic.line === undefined) {
        throw new TypeError("Redaction boundary diagnostic is missing a line number");
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

const formatOffender = (root: string, offender: RedactionBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkRedactionBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Redaction boundary check passed.\n");
  } else {
    process.stderr.write(
      `Redaction boundary check failed. Redaction sentinels and ad-hoc secret-matching regexes must route through @lando/sdk/secrets.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
