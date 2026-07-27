import { relative, resolve } from "node:path";

import { runArchitectureChecks } from "./architecture/runner.ts";

export interface StateStoreBoundaryOffender {
  readonly file: string;
  readonly signals: ReadonlyArray<string>;
}

export interface StateStoreBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<StateStoreBoundaryOffender>;
}

interface CheckStateStoreBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkStateStoreBoundary = async (
  options: CheckStateStoreBoundaryOptions = {},
): Promise<StateStoreBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runArchitectureChecks({
    root,
    ruleIds: ["state-store-boundary"],
    auditExceptions: false,
  });
  const offenders = result.diagnostics
    .map(
      (diagnostic): StateStoreBoundaryOffender => ({
        file: resolve(root, diagnostic.file),
        signals: diagnostic.message.split(", "),
      }),
    )
    .sort((left, right) => left.file.localeCompare(right.file));

  return { ok: offenders.length === 0, offenders };
};

const formatOffender = (root: string, offender: StateStoreBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}: ${offender.signals.join(", ")}`;

if (import.meta.main) {
  const result = await checkStateStoreBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write("State-store boundary check passed.\n");
  } else {
    process.stderr.write(
      `State-store boundary check failed. Durable atomic-write + lockfile + version-envelope logic must route through core/src/state/.\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
