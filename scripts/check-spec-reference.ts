import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { specReferenceRule } from "./boundary/rules/spec-reference.ts";

export interface SpecReferenceOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface SpecReferenceResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<SpecReferenceOffender>;
}

interface CheckSpecReferenceOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkSpecReference = async (
  options: CheckSpecReferenceOptions = {},
): Promise<SpecReferenceResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([specReferenceRule.id], root);
  const result = results.get(specReferenceRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${specReferenceRule.id}`);

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    match: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const results = await runRules([specReferenceRule.id], repoRoot);
  const result = results.get(specReferenceRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${specReferenceRule.id}`);
  writeGateResult(specReferenceRule.passMessage, specReferenceRule.failureHeadline, result);
}
