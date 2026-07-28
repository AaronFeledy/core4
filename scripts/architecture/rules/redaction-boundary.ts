import ts from "typescript";

import type { Diagnostic, Rule } from "../types.ts";

const SENTINEL_TEXTS = new Set(["[redacted]", "[REDACTED]"]);

/**
 * Returns true when a regex literal source string looks like an ad-hoc
 * secret-redaction pattern. Conservative: requires a multi-signal match to
 * avoid false positives on ordinary URL or token-path regexes.
 */
const isAdHocSecretRegex = (src: string): boolean => {
  const lower = src.toLowerCase();

  // Signal 1: bearer/authorization header pattern.
  if (/bearer[\s\\]/.test(lower) || lower.includes("authorization")) return true;

  // Signal 2: URL userinfo credential shape.
  if (src.includes("@") && (src.includes("[^@") || src.includes(":[^"))) return true;

  // Signal 3: signed-query shape.
  if (/\[\?&\].*(?:token|api_key|apikey|access_token|password|secret|credential|signature)\s*=/.test(lower)) {
    return true;
  }

  // Signal 4: two or more secret-key alternation keywords.
  const secretKeywords = [
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "bearer",
    "apikey",
    "api_key",
  ] as const;
  let keywordCount = 0;
  for (const keyword of secretKeywords) {
    if (lower.includes(keyword)) keywordCount++;
    if (keywordCount >= 2) return true;
  }

  return false;
};

const analyzeSource = (file: string, source: ts.SourceFile): ReadonlyArray<Diagnostic> => {
  const diagnostics: Diagnostic[] = [];

  const record = (node: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push({ ruleId: "redaction-boundary", file, line: line + 1, message });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      SENTINEL_TEXTS.has(node.text)
    ) {
      record(node, node.text);
    }

    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const regexText = node.getText(source);
      if (isAdHocSecretRegex(regexText)) record(node, regexText);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return diagnostics;
};

export const redactionBoundaryRule: Rule = {
  id: "redaction-boundary",
  title: "Redaction boundary",
  failureHeadline:
    "Redaction boundary check failed. Redaction sentinels and ad-hoc secret-matching regexes must route through @lando/sdk/secrets.",
  async run(context) {
    const files = await context.files("core-and-plugin-sources");
    return (
      await Promise.all(
        files.map(async (file) => analyzeSource(file.relativePath, await context.sourceFile(file))),
      )
    ).flat();
  },
};
