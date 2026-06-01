import type { ConfigLintViolation } from "@lando/sdk/schema";

export const renderConfigLintViolation = (violation: ConfigLintViolation): string => {
  const where = violation.path.length === 0 ? "(root)" : violation.path;
  const lines = [`  ${where}: ${violation.message}`];
  if (violation.suggestedFix !== undefined) lines.push(`    fix: ${violation.suggestedFix}`);
  return lines.join("\n");
};
