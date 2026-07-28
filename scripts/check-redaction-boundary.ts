import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { formatViolation, writeGateResult } from "./boundary/format.ts";
import { redactionRule } from "./boundary/rules/redaction.ts";

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
  const results = await runRules([redactionRule.id], root);
  const result = results.get(redactionRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${redactionRule.id}`);

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    match: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const root = repoRoot;
  const results = await runRules([redactionRule.id], root);
  const result = results.get(redactionRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${redactionRule.id}`);
  // Keep CLI strings byte-identical to the pre-substrate gate.
  void formatViolation;
  writeGateResult(redactionRule.passMessage, redactionRule.failureHeadline, result);
}
