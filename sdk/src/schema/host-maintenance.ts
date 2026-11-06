import { Schema } from "effect";

// ============================================================================
// Plugin-owned host uninstall plans and execution results
// ============================================================================

export const HostUninstallStepStatus = Schema.Literals(["owned", "user-owned", "skipped", "manual"]);
export const HostUninstallOutcomeStatus = Schema.Literals(["completed", "failed", "manual", "skipped"]);

const stepFields = {
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  destructive: Schema.Boolean,
  detail: Schema.String,
};

const plannedFields = {
  ...stepFields,
  outcome: Schema.optionalKey(Schema.Never),
  error: Schema.optionalKey(Schema.Never),
};

export const UninstallPlanStep = Schema.Union([
  Schema.Struct({ ...plannedFields, status: Schema.Literal("owned") }),
  Schema.Struct({ ...plannedFields, status: Schema.Literal("user-owned") }),
  Schema.Struct({ ...plannedFields, status: Schema.Literal("skipped") }),
  Schema.Struct({ ...plannedFields, status: Schema.Literal("manual") }),
]);
export type UninstallPlanStep = typeof UninstallPlanStep.Type;

export const HostUninstallStep = Schema.Struct({
  ...plannedFields,
  status: HostUninstallStepStatus,
  preserveOnKeepData: Schema.optionalKey(Schema.Boolean),
});
export type HostUninstallStep = typeof HostUninstallStep.Type;

const completed = Schema.Struct({
  outcome: Schema.Literal("completed"),
  error: Schema.optionalKey(Schema.Never),
  detail: Schema.optionalKey(Schema.String),
});
const skipped = Schema.Struct({
  outcome: Schema.Literal("skipped"),
  error: Schema.optionalKey(Schema.Never),
  detail: Schema.optionalKey(Schema.String),
});
const manual = Schema.Struct({
  outcome: Schema.Literal("manual"),
  error: Schema.optionalKey(Schema.Never),
  detail: Schema.String,
});
const failed = Schema.Struct({
  outcome: Schema.Literal("failed"),
  error: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});

export const HostUninstallOutcome = Schema.Union([completed, skipped, manual, failed]);
export type HostUninstallOutcome = typeof HostUninstallOutcome.Type;

// Classification is the planning observation, even after ownership changes.
// Manual shell cleanup can complete; failed discovery can be user-owned.
export const UninstallStepResult = Schema.Union([
  Schema.Struct({
    ...completed.fields,
    ...stepFields,
    status: Schema.Literals(["owned", "manual"]),
  }),
  Schema.Struct({
    ...skipped.fields,
    ...stepFields,
    status: Schema.Literals(["owned", "skipped"]),
  }),
  Schema.Struct({
    ...manual.fields,
    ...stepFields,
    status: Schema.Literals(["owned", "user-owned", "manual"]),
  }),
  Schema.Struct({
    ...failed.fields,
    ...stepFields,
    status: Schema.Literals(["owned", "user-owned", "manual"]),
  }),
]);
export type UninstallStepResult = typeof UninstallStepResult.Type;
