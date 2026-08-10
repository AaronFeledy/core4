import ts from "typescript";

import type { BoundaryRule } from "../types.ts";
import { CORE_AND_PLUGIN_SOURCE_ROOTS } from "../workspace-roots.ts";

const SENTINEL_TEXTS = new Set(["[redacted]", "[REDACTED]"]);

/**
 * Returns true when a regex literal source string looks like an ad-hoc
 * secret-redaction pattern.  Conservative: requires a multi-signal match to
 * avoid false positives on ordinary URL or token-path regexes.
 */
const isAdHocSecretRegex = (src: string): boolean => {
  const lower = src.toLowerCase();

  // Signal 1: bearer/authorization header pattern
  // "bearer" followed by \s or whitespace-class intent, or the word "authorization"
  if (/bearer[\s\\]/.test(lower) || lower.includes("authorization")) return true;

  // Signal 2: URL userinfo credential shape — contains @ AND a credential-ish
  // capture group like [^@...] or :[^ — i.e. `:` then `@` with char-class between
  if (src.includes("@") && (src.includes("[^@") || src.includes(":[^"))) return true;

  // Signal 3: signed-query shape — [?&] near a secret keyword followed by =
  if (/\[\?&\].*(?:token|api_key|apikey|access_token|password|secret|credential|signature)\s*=/.test(lower)) {
    return true;
  }

  // Signal 4: two or more secret-key alternation keywords (clearly a secret-key regex)
  const secretKeywords = [
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "bearer",
    "apikey",
    "api_key",
  ];
  let keywordCount = 0;
  for (const kw of secretKeywords) {
    if (lower.includes(kw)) keywordCount++;
    if (keywordCount >= 2) return true;
  }

  return false;
};

export const redactionRule = {
  id: "redaction",
  scope: {
    roots: CORE_AND_PLUGIN_SOURCE_ROOTS.filter((root) => root !== "redaction/src"),
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Redaction boundary check passed.",
  failureHeadline:
    "Redaction boundary check failed. Redaction sentinels and ad-hoc secret-matching regexes must route through @lando/sdk/secrets.",
  onNode: (node, context) => {
    // Sentinel string literals: exact whole-string match on [redacted] or [REDACTED]
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (SENTINEL_TEXTS.has(node.text)) {
        const source = node.getSourceFile();
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        context.report({ line: line + 1, detail: node.text });
      }
      return;
    }

    // Ad-hoc secret regex literals
    if (ts.isRegularExpressionLiteral(node)) {
      if (isAdHocSecretRegex(node.text)) {
        const source = node.getSourceFile();
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        context.report({ line: line + 1, detail: node.text });
      }
    }
  },
} satisfies BoundaryRule;
