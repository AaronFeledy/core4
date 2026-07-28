import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface ProbeBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface ProbeBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<ProbeBoundaryOffender>;
}

interface CheckProbeBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkProbeBoundary = async (
  options: CheckProbeBoundaryOptions = {},
): Promise<ProbeBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["probe-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics.map((diagnostic): ProbeBoundaryOffender => {
    if (diagnostic.line === undefined) {
      throw new TypeError("Probe boundary diagnostics require a source line");
    }
    return {
      file: resolve(root, diagnostic.file),
      line: diagnostic.line,
      match: diagnostic.message,
    };
  });

  return { ok: result.ok, offenders };
};

const formatOffender = (root: string, offender: ProbeBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}: ${offender.match}`;

if (import.meta.main) {
  const result = await checkProbeBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("Probe boundary check passed.\n");
  } else {
    process.stderr.write(
      `Probe boundary check failed. Host/provider-shaped retry/backoff/timeout-to-verdict probing must build on @lando/sdk/probe (runProbe), not hand-rolled Effect.retry/repeat/schedule or Schedule loops.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
