import type { ToolingCompileError } from "@lando/sdk/errors";
import type { ValidationIssue, ValidationIssuePath, ValidationIssueSource } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";

export type ToolingDiagnostic = Pick<
  ToolingCompileError,
  "_tag" | "tool" | "source" | "message" | "remediation" | "issues" | "omittedIssueCount"
>;

const MAX_BYTES = 16 * 1024;
const MAX_SUMMARY_BYTES = 1024;
const MAX_ISSUES = 8;
const encoder = new TextEncoder();
const serializedBytes = (value: ToolingDiagnostic | string): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

export const boundedDiagnosticSummary = (redacted: string): string => {
  if (serializedBytes(redacted) <= MAX_SUMMARY_BYTES) return redacted;
  let result = "";
  let bytes = serializedBytes("...");
  for (const character of redacted) {
    const size = serializedBytes(character) - 2;
    if (bytes + size > MAX_SUMMARY_BYTES) break;
    result += character;
    bytes += size;
  }
  return `${result}...`;
};

/** Disclose only this allowlisted contract, after binding all known secrets to the required redactor. */
export const projectToolingDiagnostic = (
  diagnostic: ToolingDiagnostic,
  redactor: Pick<Redactor, "redactString">,
): ToolingDiagnostic => {
  const text = (value: string) => redactor.redactString(value);
  const path = (value: ValidationIssuePath) =>
    value.map((segment) => (typeof segment === "string" ? text(segment) : segment));
  const source = (value: ValidationIssueSource): ValidationIssueSource => {
    const location = { layer: value.layer, path: path(value.path) };
    switch (value.layer) {
      case "base":
      case "dist":
      case "upstream":
      case "canonical":
      case "local":
      case "user":
      case "config-file":
      case "config-drop-in":
      case "script":
        return { ...location, layer: value.layer, file: text(value.file) };
      case "env":
        return { ...location, layer: value.layer, variable: text(value.variable) };
      case "host":
      case "default":
        return { ...location, layer: value.layer };
      default:
        return value satisfies never;
    }
  };
  const location = (value: Pick<ValidationIssue, "path" | "source">) => ({
    path: path(value.path),
    ...(value.source === undefined ? {} : { source: source(value.source) }),
  });
  const tool = text(diagnostic.tool);
  const summary: ToolingDiagnostic = {
    _tag: "ToolingCompileError",
    tool: serializedBytes(tool) <= MAX_SUMMARY_BYTES ? tool : "[omitted]",
    message: boundedDiagnosticSummary(text(diagnostic.message)),
    remediation: boundedDiagnosticSummary(text(diagnostic.remediation)),
    issues: [],
    omittedIssueCount: diagnostic.omittedIssueCount + diagnostic.issues.length,
  };
  const withSource: ToolingDiagnostic = {
    ...summary,
    ...(diagnostic.source === undefined
      ? {}
      : {
          source: {
            path: text(diagnostic.source.path),
            task: text(diagnostic.source.task),
          },
        }),
  };
  // Never shorten filenames or identities into plausible but false locations.
  let result = serializedBytes(withSource) <= MAX_BYTES ? withSource : summary;
  for (const issue of diagnostic.issues) {
    if (result.issues.length === MAX_ISSUES) break;
    const sanitized: ValidationIssue = {
      ...location(issue),
      message: text(issue.message),
      ...(issue.rule === undefined ? {} : { rule: issue.rule }),
      ...(issue.kind === undefined ? {} : { kind: issue.kind }),
      ...(issue.reason === undefined ? {} : { reason: text(issue.reason) }),
      ...(issue.suggestion === undefined ? {} : { suggestion: text(issue.suggestion) }),
      ...(issue.related === undefined ? {} : { related: issue.related.map(location) }),
    };
    const candidate: ToolingDiagnostic = {
      ...result,
      issues: [...result.issues, sanitized],
      omittedIssueCount: result.omittedIssueCount - 1,
    };
    if (serializedBytes(candidate) <= MAX_BYTES) result = candidate;
  }
  return result;
};
