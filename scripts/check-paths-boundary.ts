import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { formatViolation, writeGateResult } from "./boundary/format.ts";
import { pathsRule } from "./boundary/rules/paths.ts";

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

export const checkPathsBoundary = async (
  options: CheckPathsBoundaryOptions = {},
): Promise<PathsBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([pathsRule.id], root);
  const result = results.get(pathsRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${pathsRule.id}`);

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    snippet: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const root = repoRoot;
  const results = await runRules([pathsRule.id], root);
  const result = results.get(pathsRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${pathsRule.id}`);
  // Keep CLI strings byte-identical to the pre-substrate gate.
  void formatViolation;
  writeGateResult(pathsRule.passMessage, pathsRule.failureHeadline, result);
}
