import { formatValidationIssuePath } from "@lando/sdk/schema";
import { escapeDiagnosticText } from "./diagnostic-text.ts";

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
  return `${location}${where.length === 0 ? "" : `${where}: `}${message}${hint}${original}`;
};
