import { TaggedErrorJson, ValidationIssuePath, formatValidationIssuePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import { formatStructuredIssue } from "./validation-issue-text";

export const formatDiagnosticPath = (value: unknown): string | undefined =>
  Schema.is(ValidationIssuePath)(value) ? formatValidationIssuePath(value) : undefined;

export const formatDiagnosticFailures = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const lines: string[] = [];
  for (const member of value) {
    if (!Schema.is(TaggedErrorJson)(member)) continue;
    const source = member.source;
    const location = source !== null && typeof source === "object" ? source : {};
    const path =
      formatDiagnosticPath(member.path) ??
      formatDiagnosticPath(member.sourcePath) ??
      formatDiagnosticPath(Reflect.get(location, "path")) ??
      member.configPath;
    lines.push(`${path ? `${path}: ` : ""}${member.message}`);
    const file =
      Reflect.get(location, "file") ??
      member.file ??
      member.filePath ??
      member.sourceFile ??
      member.sourcePath;
    const line = Reflect.get(location, "line") ?? member.line;
    const column = Reflect.get(location, "column") ?? member.column;
    const layer = Reflect.get(location, "layer") ?? member.layer;
    if (typeof file === "string") {
      let position = file;
      if (typeof line === "number") {
        position += `:${line}`;
        if (typeof column === "number") position += `:${column}`;
      }
      lines.push(`  at ${position}${typeof layer === "string" ? ` (${layer} layer)` : ""}`);
    }
    for (const issue of member.issues ?? []) {
      const text = formatStructuredIssue(issue);
      if (text !== undefined) lines.push(`  ${text}`);
    }
    const nested = formatDiagnosticFailures(member.failures);
    if (nested !== undefined) lines.push(nested);
    lines.push(`  ↳ ${member.remediation}`);
  }
  return lines.length === 0 ? undefined : lines.join("\n");
};
