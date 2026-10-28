import { Schema } from "effect";
import { type LanguageSource, LanguageSourceSchema, languageSource } from "../language/errors.ts";

export class PlanningError extends Schema.TaggedError<PlanningError>()("PlanningError", {
  code: Schema.Literals([
    "action-metadata-limit",
    "action-metadata-mismatch",
    "completion-invalid",
    "completion-limit",
    "duplicate-job",
    "elapsed-invalid",
    "graph-invalid",
    "job-field-invalid",
    "job-invalid",
    "job-limit",
    "matrix-axis-invalid",
    "matrix-filter-invalid",
    "matrix-input-limit",
    "matrix-invalid",
    "matrix-limit",
    "matrix-work-limit",
    "needs-cycle",
    "outputs-invalid",
    "parallel-limit",
    "plan-invalid",
    "plan-limit",
    "projection-invalid",
    "projection-limit",
    "runner-invalid",
    "self-needs",
    "start-invalid",
    "step-limit",
    "strategy-invalid",
    "unknown-needs",
    "unsupported-composite-expansion",
    "unsupported-concurrency",
    "unsupported-environment",
    "unsupported-oidc",
    "unsupported-reusable-workflow",
    "unsupported-snapshot",
    "unsupported-step-kind",
    "workflow-matrix-limit",
  ]),
  source: LanguageSourceSchema,
  message: Schema.Literal("GitHub Actions planning could not complete."),
  remediation: Schema.String,
}) {}
export const planningError = (
  code: PlanningError["code"],
  source: LanguageSource = { file: "planning-input" },
) =>
  new PlanningError({
    code,
    source: languageSource(source),
    message: "GitHub Actions planning could not complete.",
    remediation: code.includes("limit")
      ? "Reduce the workflow to the finite local planning budgets."
      : "Correct the indicated workflow field or remove unsupported intent before planning.",
  });
