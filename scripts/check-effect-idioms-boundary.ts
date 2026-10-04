import { resolve } from "node:path";

import { runRuleSet } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { effectIdiomsRule } from "./boundary/rules/effect-idioms.ts";

export interface EffectIdiomsBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface EffectIdiomsBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<EffectIdiomsBoundaryOffender>;
}

interface CheckEffectIdiomsBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

const runEffectIdiomsRule = async (root: string) => {
  const results = await runRuleSet([effectIdiomsRule], root);
  const result = results.get(effectIdiomsRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${effectIdiomsRule.id}`);
  return result;
};

export const checkEffectIdiomsBoundary = async (
  options: CheckEffectIdiomsBoundaryOptions = {},
): Promise<EffectIdiomsBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runEffectIdiomsRule(root);
  return {
    ok: result.ok,
    offenders: result.violations.map((violation) => ({
      file: resolve(root, violation.file),
      line: violation.line,
      match: violation.detail,
    })),
  };
};

if (import.meta.main) {
  const result = await runEffectIdiomsRule(repoRoot);
  writeGateResult(effectIdiomsRule.passMessage, effectIdiomsRule.failureHeadline, result);
}
