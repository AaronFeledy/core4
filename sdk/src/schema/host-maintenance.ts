import { Schema } from "effect";

// ============================================================================
// Plugin-owned host uninstall plans and execution results
// ============================================================================

export const HostUninstallStepStatus = Schema.Literals(["owned", "user-owned", "skipped", "manual"]);
export const HostUninstallOutcomeStatus = Schema.Literals(["completed", "failed", "manual", "skipped"]);

export const HostUninstallStep = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  target: Schema.String,
  destructive: Schema.Boolean,
  status: HostUninstallStepStatus,
  detail: Schema.String,
  preserveOnKeepData: Schema.optionalKey(Schema.Boolean),
});
export type HostUninstallStep = typeof HostUninstallStep.Type;

export const HostUninstallOutcome = Schema.Struct({
  outcome: HostUninstallOutcomeStatus,
  error: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type HostUninstallOutcome = typeof HostUninstallOutcome.Type;
