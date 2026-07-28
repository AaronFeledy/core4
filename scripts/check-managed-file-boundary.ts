import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { managedFileRule } from "./boundary/rules/managed-file.ts";

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
  const results = await runRules([managedFileRule.id], root);
  const result = results.get(managedFileRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${managedFileRule.id}`);

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    match: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const results = await runRules([managedFileRule.id], repoRoot);
  const result = results.get(managedFileRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${managedFileRule.id}`);
  writeGateResult(managedFileRule.passMessage, managedFileRule.failureHeadline, result);
}
