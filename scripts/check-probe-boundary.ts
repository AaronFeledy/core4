import { resolve } from "node:path";

import { runRuleSet } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { probeRule } from "./boundary/rules/probe.ts";

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

const runProbeRule = async (root: string) => {
  const results = await runRuleSet([probeRule], root);
  const result = results.get(probeRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${probeRule.id}`);
  return result;
};

export const checkProbeBoundary = async (
  options: CheckProbeBoundaryOptions = {},
): Promise<ProbeBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const result = await runProbeRule(root);
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
  const result = await runProbeRule(repoRoot);
  writeGateResult(probeRule.passMessage, probeRule.failureHeadline, result);
}
