import { runRules } from "./engine.ts";
import { BOUNDARY_RULES } from "./registry.ts";
import type { BoundaryRuleResult, Violation } from "./types.ts";

const normalizePath = (path: string): string => path.replaceAll("\\", "/");

export const formatViolation = (violation: Violation): string =>
  `${normalizePath(violation.file)}:${violation.line}: ${violation.detail}`;

export const sortViolations = (violations: readonly Violation[]): readonly Violation[] =>
  violations.slice().sort((left, right) => {
    const fileOrder = normalizePath(left.file).localeCompare(normalizePath(right.file));
    return fileOrder || left.line - right.line;
  });

export const writeGateResult = (
  passMessage: string,
  failureHeadline: string,
  result: BoundaryRuleResult,
): void => {
  if (result.ok) {
    process.stdout.write(`${passMessage}\n`);
    return;
  }
  const details = sortViolations(result.violations).map(formatViolation).join("\n");
  process.stderr.write(`${failureHeadline}\n${details}\n`);
  process.exitCode = 1;
};

export const runGate = async (ruleId: string, root: string): Promise<void> => {
  const rule = BOUNDARY_RULES.get(ruleId);
  if (rule === undefined) throw new TypeError(`Unknown boundary rule: ${ruleId}`);
  const results = await runRules([ruleId], root);
  const result = results.get(ruleId);
  if (result === undefined) throw new TypeError(`Boundary rule produced no result: ${ruleId}`);
  writeGateResult(rule.passMessage, rule.failureHeadline, result);
};
