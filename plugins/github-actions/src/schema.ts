import { Effect, Schema } from "effect";
import { inputIssueError } from "./errors.ts";

// ==== Inspection input: no execution, event simulation, or credential options.
const PathText = Schema.String.check(Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u), Schema.isPattern(/\S/u));
export const WorkflowPath = PathText.check(Schema.isPattern(/^\.github\/workflows\/[^/\\]+\.ya?ml$/u));
export const ListWorkflowsOptions = Schema.Struct({
  root: PathText,
  workflow: Schema.optionalKey(WorkflowPath),
});
export type ListWorkflowsOptions = typeof ListWorkflowsOptions.Type;
export const decodeListWorkflowsOptions = (input: unknown) =>
  Schema.decodeUnknownEffect(ListWorkflowsOptions)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => inputIssueError(error.issue)),
  );

// ==== Safe, source-located observations. No runtime AST or authored scripts.
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SourceLocation = Schema.Struct({
  workflow: Schema.String,
  line: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  column: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type SourceLocation = typeof SourceLocation.Type;
export const DiagnosticCode = Schema.Literals([
  "unreadable-file",
  "invalid-encoding",
  "unsafe-file",
  "file-limit",
  "aggregate-limit",
  "yaml-syntax",
  "yaml-alias",
  "yaml-depth",
  "yaml-nodes",
  "workflow-invalid",
  "workflow-duplicate-key",
  "workflow-unknown-key",
  "workflow-required",
  "workflow-type",
  "parser-failure",
]);
export type DiagnosticCode = typeof DiagnosticCode.Type;
export const DiagnosticField = Schema.Literals([
  "workflow",
  "jobs",
  "on",
  "runs-on",
  "needs",
  "steps",
  "strategy",
  "uses",
  "run",
  "name",
]);
export type DiagnosticField = typeof DiagnosticField.Type;
export const WorkflowDiagnostic = Schema.Struct({
  code: DiagnosticCode,
  severity: Schema.Literal("error"),
  source: SourceLocation,
  field: Schema.optionalKey(DiagnosticField),
  path: Schema.optionalKey(Schema.Array(DiagnosticField)),
  rule: Schema.optionalKey(
    Schema.Literals(["duplicate-key", "unknown-key", "required", "type", "value", "expression", "syntax"]),
  ),
  remediation: Schema.String,
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;
export const InspectionStep = Schema.Struct({
  source: SourceLocation,
  category: Schema.Literals([
    "script",
    "local-action",
    "repository-action",
    "container-action",
    "unresolved-action",
    "unassessed",
  ]),
});
export const InspectionJob = Schema.Struct({
  id: Schema.String,
  source: SourceLocation,
  kind: Schema.Literals(["job", "reusable-workflow"]),
  needs: Schema.Array(Schema.String),
  runnerLabels: Schema.Array(Schema.String),
  runnerAssessment: Schema.Literals(["literal", "unresolved", "unassessed"]),
  matrix: Schema.Literals(["unassessed", "absent"]),
  steps: Schema.Array(InspectionStep),
});
export type InspectionJob = typeof InspectionJob.Type;
export const InspectedWorkflow = Schema.Struct({
  source: SourceLocation,
  status: Schema.Literals(["inspected", "failed", "uninspected"]),
  name: Schema.optionalKey(Schema.String),
  triggers: Schema.Array(Schema.String),
  jobs: Schema.Array(InspectionJob),
  diagnostics: Schema.Array(WorkflowDiagnostic),
  diagnosticsTruncated: Schema.Boolean,
});
export type InspectedWorkflow = typeof InspectedWorkflow.Type;
export const WorkflowInspection = Schema.Struct({
  workflows: Schema.Array(InspectedWorkflow),
  summary: Schema.Struct({ discovered: Count, inspected: Count, failed: Count, uninspected: Count }),
  complete: Schema.Boolean,
  diagnosticsTruncated: Schema.Boolean,
  assessment: Schema.Literal("execution-unassessed"),
});
export type WorkflowInspection = typeof WorkflowInspection.Type;
