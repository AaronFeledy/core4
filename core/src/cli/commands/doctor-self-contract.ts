import { Schema } from "effect";

export const DOCTOR_SELF_CHECK_NAME = "doctor-self";

export type DoctorSelfFailureReason = "failure" | "defect" | "timeout";

/**
 * Remediation attached to a self check. Structurally identical to
 * `DoctorSolution`, declared locally so this module stays a leaf that
 * `doctor.ts` can depend on without an import cycle.
 */
export interface DoctorSelfSolution {
  readonly kind: "automatic" | "manual";
  readonly description: string;
  readonly command?: string;
}

/**
 * A failure of doctor's own machinery rather than of the host being
 * diagnosed. Reported alongside the sections that did answer.
 */
export interface DoctorSelfCheck {
  readonly name: typeof DOCTOR_SELF_CHECK_NAME;
  /** The report section that failed (e.g. `subsystems`, `mcp`). */
  readonly section: string;
  readonly status: "fail";
  readonly severity: "error";
  readonly reason: DoctorSelfFailureReason;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSelfSolution>;
}

export interface DoctorSelfReport {
  readonly checks: ReadonlyArray<DoctorSelfCheck>;
}

const DoctorSelfSolutionSchema = Schema.Struct({
  kind: Schema.Literals(["automatic", "manual"]),
  description: Schema.String,
  command: Schema.optionalKey(Schema.String),
});

export const DoctorSelfCheckSchema = Schema.Struct({
  name: Schema.Literal(DOCTOR_SELF_CHECK_NAME),
  section: Schema.String,
  status: Schema.Literal("fail"),
  severity: Schema.Literal("error"),
  reason: Schema.Literals(["failure", "defect", "timeout"]),
  context: Schema.Record(Schema.String, Schema.String),
  solutions: Schema.Array(DoctorSelfSolutionSchema),
});

export const DoctorSelfReportSchema = Schema.Struct({
  checks: Schema.Array(DoctorSelfCheckSchema),
});
