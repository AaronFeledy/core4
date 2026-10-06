import { resolve } from "node:path";

import { runRuleSet } from "./engine.ts";
import { writeGateResult } from "./format.ts";
import type { BoundaryRule, BoundaryRuleResult } from "./types.ts";

export interface SingleRuleGateOffender {
  readonly file: string;
  readonly line: number;
  readonly match: string;
}

export interface SingleRuleGateResult {
  readonly ok: boolean;
  readonly offenders: ReadonlyArray<SingleRuleGateOffender>;
}

export interface SingleRuleGateOptions {
  readonly root?: string;
}

const repoRoot = resolve(import.meta.dirname, "../..");

export const singleRuleGate = (rule: BoundaryRule) => {
  const run = async (root: string): Promise<BoundaryRuleResult> => {
    const results = await runRuleSet([rule], root);
    const result = results.get(rule.id);
    if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${rule.id}`);
    return result;
  };

  return {
    check: async (options: SingleRuleGateOptions = {}): Promise<SingleRuleGateResult> => {
      const root = resolve(options.root ?? repoRoot);
      const result = await run(root);
      return {
        ok: result.ok,
        offenders: result.violations.map((violation) => ({
          file: resolve(root, violation.file),
          line: violation.line,
          match: violation.detail,
        })),
      };
    },
    main: async (): Promise<void> => {
      writeGateResult(rule.passMessage, rule.failureHeadline, await run(repoRoot));
    },
  };
};
