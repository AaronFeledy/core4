import { resolve } from "node:path";

import { runRules } from "./boundary/engine.ts";
import { writeGateResult } from "./boundary/format.ts";
import { rendererRule } from "./boundary/rules/renderer.ts";

export interface RendererBoundaryOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface RendererBoundaryResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<RendererBoundaryOffender>;
}

interface CheckRendererBoundaryOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "..");

export const checkRendererBoundary = async (
  options: CheckRendererBoundaryOptions = {},
): Promise<RendererBoundaryResult> => {
  const root = resolve(options.root ?? repoRoot);
  const results = await runRules([rendererRule.id], root);
  const result = results.get(rendererRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${rendererRule.id}`);

  const offenders = result.violations.map((violation) => ({
    file: resolve(root, violation.file),
    line: violation.line,
    match: violation.detail,
  }));

  return { ok: result.ok, offenders };
};

if (import.meta.main) {
  const results = await runRules([rendererRule.id], repoRoot);
  const result = results.get(rendererRule.id);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${rendererRule.id}`);
  writeGateResult(rendererRule.passMessage, rendererRule.failureHeadline, result);
}
