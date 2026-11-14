import type { ToolingCompileError } from "@lando/sdk/errors";
import type { ValidationIssue, ValidationIssuePath, ValidationIssueSource } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { encodeRedactedJson } from "./redacted-json.ts";

export type ToolingDiagnostic = Pick<
  ToolingCompileError,
  "_tag" | "tool" | "source" | "message" | "remediation" | "issues" | "omittedIssueCount"
>;

const MAX_BYTES = 16 * 1024;
const MAX_SUMMARY_BYTES = 1024;
const MAX_ISSUES = 8;
const encoder = new TextEncoder();
const serializedBytes = (
  value: ToolingDiagnostic | string,
  redactor: Pick<Redactor, "redactString">,
): number => encoder.encode(encodeRedactedJson(value, redactor)).byteLength;

export const boundedDiagnosticSummary = (
  redacted: string,
  redactor: Pick<Redactor, "redactString"> = { redactString: (text) => text },
): string => {
  if (serializedBytes(redacted, redactor) <= MAX_SUMMARY_BYTES) return redacted;
  const characters = Array.from(redacted);
  let end = characters.length;
  while (end > 0) {
    const candidate = `${characters.slice(0, end).join("")}...`;
    const bytes = serializedBytes(candidate, redactor);
    if (bytes <= MAX_SUMMARY_BYTES) return candidate;
    end -= Math.max(1, Math.ceil((bytes - MAX_SUMMARY_BYTES) / 6));
  }
  return "...";
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
    tool: serializedBytes(tool, redactor) <= MAX_SUMMARY_BYTES ? tool : "[omitted]",
    message: boundedDiagnosticSummary(text(diagnostic.message), redactor),
    remediation: boundedDiagnosticSummary(text(diagnostic.remediation), redactor),
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
  let result = serializedBytes(withSource, redactor) <= MAX_BYTES ? withSource : summary;
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
    if (serializedBytes(candidate, redactor) <= MAX_BYTES) result = candidate;
  }
  return {
    _tag: result._tag,
    tool: result.tool,
    ...(result.source === undefined ? {} : { source: result.source }),
    message: result.message,
    remediation: result.remediation,
    issues: result.issues,
    omittedIssueCount: result.omittedIssueCount,
  };
};
