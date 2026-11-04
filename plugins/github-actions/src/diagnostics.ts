import type { DiagnosticCode, SourceLocation, WorkflowDiagnostic } from "./schema.ts";

export const limits = {
  files: 100,
  entries: 1000,
  fileBytes: 256 * 1024,
  aggregateBytes: 8 * 1024 * 1024,
  depth: 64,
  nodes: 50_000,
  errors: 50,
} as const;
// Escape terminal controls, bidi controls, and line separators without losing metadata identity.
export const safeText = (text: string) =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)?.toString(16)}}`,
  );
const remedies: Record<DiagnosticCode, string> = {
  "unreadable-file": "Allow read access to this workflow file, then inspect it again.",
  "invalid-encoding":
    "Save this workflow as valid UTF-8, then inspect it again; invalid bytes are not replaced.",
  "unsafe-file":
    "Use a regular workflow file inside real .github/workflows directories; symlinks and changing identities are rejected.",
  "file-limit": "Reduce this workflow to at most 256 KiB before inspection.",
  "aggregate-limit": "Inspect fewer workflows using --workflow; the aggregate read budget is 8 MiB.",
  "yaml-syntax": "Correct YAML syntax at the source location, then inspect again.",
  "yaml-alias": "Replace YAML aliases with explicit values; alias semantics are not inspected.",
  "yaml-depth": "Reduce YAML nesting to at most 64 levels.",
  "yaml-nodes": "Reduce YAML structure to at most 50000 nodes, including mapping pairs.",
  "workflow-invalid":
    "Correct the workflow structure or expression at this location using GitHub Actions workflow syntax.",
  "workflow-duplicate-key":
    "Remove the duplicate mapping key at this source location; keep one declaration in the same mapping.",
  "workflow-unknown-key":
    "Remove or correct the unrecognized workflow property at this source location using the GitHub Actions workflow syntax.",
  "workflow-required":
    "Add the required workflow property identified by the diagnostic path using GitHub Actions workflow syntax.",
  "workflow-type":
    "Use the GitHub Actions value type required by the property identified by the diagnostic path.",
  "parser-failure": "Simplify this workflow and validate its GitHub Actions syntax before retrying.",
};
export const diagnostic = (code: DiagnosticCode, source: SourceLocation): WorkflowDiagnostic => ({
  code,
  severity: "error",
  source,
  remediation: remedies[code],
});
export const location = (
  workflow: string,
  position?: { readonly line: number; readonly column: number },
): SourceLocation => ({
  workflow: safeText(workflow),
  ...(position === undefined ? {} : position),
});
