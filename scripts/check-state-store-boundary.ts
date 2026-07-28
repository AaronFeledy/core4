import { relative, resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { stateStoreRule } from "./boundary/rules/state-store.ts";

export interface StateStoreBoundaryOffender {
  readonly file: string;
  readonly signals: ReadonlyArray<string>;
}

export interface StateStoreBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<StateStoreBoundaryOffender>;
}

export interface CheckStateStoreBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkStateStoreBoundary = async (
  options: CheckStateStoreBoundaryOptions = {},
): Promise<StateStoreBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([stateStoreRule.id], root);
  const result = results.get(stateStoreRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${stateStoreRule.id}`);
  return {
    ok: result.ok,
    offenders: result.violations.map((violation) => ({
      file: resolve(root, violation.file),
      signals: violation.detail.split(", "),
    })),
  };
};

const formatOffender = (root: string, offender: StateStoreBoundaryOffender): string =>
  `${relative(root, offender.file).replaceAll("\\", "/")}: ${offender.signals.join(", ")}`;

if (import.meta.main) {
  const result = await checkStateStoreBoundary({ root: repoRoot });
  if (result.ok) {
    process.stdout.write(`${stateStoreRule.passMessage}\n`);
  } else {
    process.stderr.write(
      `${stateStoreRule.failureHeadline}\n${result.offenders
        .map((offender) => formatOffender(repoRoot, offender))
        .join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
