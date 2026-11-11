import { ValidationFix, formatValidationIssuePath } from "@lando/sdk/schema";
import { Schema } from "effect";
import { escapeDiagnosticText } from "./diagnostic-text.ts";
import { formatValidationFixEdits } from "./validation-fix-text.ts";

export const formatStructuredIssue = (issue: unknown): string | undefined => {
  if (typeof issue !== "object" || issue === null) return undefined;
  const path = Reflect.get(issue, "path");
  const message = Reflect.get(issue, "message");
  const suggestion = Reflect.get(issue, "suggestion");
  if (typeof message !== "string" || !Array.isArray(path)) return undefined;
  const segments: Array<string | number> = [];
  for (const segment of path) {
    if (typeof segment !== "string" && typeof segment !== "number") return undefined;
    segments.push(segment);
  }
  const where = formatValidationIssuePath(segments);
  const hint = typeof suggestion === "string" ? `${/[.?!:]$/.test(message) ? "" : "."} ${suggestion}` : "";
  const source = Reflect.get(issue, "source");
  const sourceFile = typeof source === "object" && source !== null ? Reflect.get(source, "file") : undefined;
  const sourcePath = typeof source === "object" && source !== null ? Reflect.get(source, "path") : undefined;
  const authored =
    Array.isArray(sourcePath) && sourcePath.every((key) => typeof key === "string" || typeof key === "number")
      ? formatValidationIssuePath(sourcePath)
      : undefined;
  const location = typeof sourceFile === "string" ? `${escapeDiagnosticText(sourceFile)}: ` : "";
  const original =
    authored !== undefined && authored !== where ? ` (authored ${escapeDiagnosticText(authored)})` : "";
  const line = `${location}${where.length === 0 ? "" : `${where}: `}${message}${hint}${original}`;
  const fix = Reflect.get(issue, "fix");
  if (!Schema.is(ValidationFix)(fix)) return line;
  // The suggestion is part of the message line here, so the edits are their own labelled block.
  return [
    line,
    ...formatValidationFixEdits(fix).map(
      (edit, index) => `${index === 0 ? "    fix: " : "       | "}${edit}`,
    ),
  ].join("\n");
};
