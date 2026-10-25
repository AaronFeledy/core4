import {
  type ConfigLintViolation,
  type ValidationIssuePath,
  formatValidationIssuePath,
  parseValidationIssuePath,
} from "@lando/sdk/schema";
import type { SchemaIssue } from "effect";
import { Predicate } from "effect";
import type { ComposeRejectionMatch } from "./compose/rejections.ts";
import { landofileIssuesFromSchema } from "./validation-suggestions.ts";

const pathFromText = (text: string): ValidationIssuePath => parseValidationIssuePath(text) ?? [];
export const rejectionViolation = (match: ComposeRejectionMatch): ConfigLintViolation => ({
  rule: "landofile.compose-rejection",
  severity: "error",
  path: pathFromText(match.documentPath),
  message: `Compose key "${match.matrixPath}" is rejected: ${match.rationale}`,
  suggestion: match.remediation,
});
const fallsWithinRejectedPath = (path: string, rejectedPath: string): boolean =>
  path === rejectedPath || path.startsWith(`${rejectedPath}.`) || path.startsWith(`${rejectedPath}[`);

export const violationsFromSchema = (
  issue: SchemaIssue.Issue,
  parsed: unknown,
  rejections: readonly ComposeRejectionMatch[] = [],
): readonly ConfigLintViolation[] =>
  landofileIssuesFromSchema(issue, parsed)
    .map((issue) => ({ ...issue, rule: "landofile.validation", severity: "error" as const }))
    // Rejection analysis belongs to a single source document, not the merged effective value.
    .filter(
      (violation) =>
        !rejections.some((rejection) =>
          fallsWithinRejectedPath(formatValidationIssuePath(violation.path), rejection.documentPath),
        ),
    );

export const appNameOf = (parsed: unknown): string => {
  if (!Predicate.isObject(parsed)) return "";
  return typeof parsed.name === "string" ? parsed.name : "";
};
