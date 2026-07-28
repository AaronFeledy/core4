import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { formatViolation, writeGateResult } from "./boundary/format.ts";
import { envHelperRule } from "./boundary/rules/env-helper.ts";

export interface EnvHelperBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface EnvHelperBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<EnvHelperBoundaryOffender>;
}

interface CheckEnvHelperBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkEnvHelperBoundary = async (
  options: CheckEnvHelperBoundaryOptions = {},
): Promise<EnvHelperBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([envHelperRule.id], root);
  const result = results.get(envHelperRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${envHelperRule.id}`);

  const offenders = result.violations
    .map((violation) => ({
      file: resolve(root, violation.file),
      line: violation.line,
      specifier: violation.detail,
    }))
    .slice()
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.specifier.localeCompare(right.specifier),
    );

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const root = repoRoot;
  const results = await runRules([envHelperRule.id], root);
  const result = results.get(envHelperRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${envHelperRule.id}`);
  // Keep CLI strings byte-identical to the pre-substrate gate.
  void formatViolation;
  writeGateResult(envHelperRule.passMessage, envHelperRule.failureHeadline, result);
}
