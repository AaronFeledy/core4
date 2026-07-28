import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { generatedOutputRule } from "./boundary/rules/generated-output.ts";

export interface GeneratedOutputOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface GeneratedOutputResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<GeneratedOutputOffender>;
}

interface CheckGeneratedOutputOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkGeneratedOutput = async (
  options: CheckGeneratedOutputOptions = {},
): Promise<GeneratedOutputResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([generatedOutputRule.id], root);
  const result = results.get(generatedOutputRule.id);
  if (result === undefined) {
    throw new TypeError(`Boundary rule produced no result: ${generatedOutputRule.id}`);
  }

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    match: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const results = await runRules([generatedOutputRule.id], repoRoot);
  const result = results.get(generatedOutputRule.id);
  if (result === undefined) {
    throw new TypeError(`Boundary rule produced no result: ${generatedOutputRule.id}`);
  }
  writeGateResult(generatedOutputRule.passMessage, generatedOutputRule.failureHeadline, result);
}
