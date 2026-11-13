import { CORE_VERSION } from "@lando/engine/version";
import type { DoctorCheck, DoctorProvider, DoctorReport, DoctorSkip, DoctorSummary } from "./doctor-contract";
import { DOCTOR_SELF_CHECK_NAME } from "./doctor-contract";

export const summarizeDoctorChecks = (checks: ReadonlyArray<DoctorCheck>): DoctorSummary => {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status]++;
  return { checks: checks.length, passed: counts.pass, warned: counts.warn, failed: counts.fail };
};

export const makeDoctorReport = (input: {
  readonly version?: string | undefined;
  readonly provider?: DoctorProvider | undefined;
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly skipped: ReadonlyArray<DoctorSkip>;
}): DoctorReport => ({
  version: input.version ?? CORE_VERSION,
  ...(input.provider === undefined ? {} : { provider: input.provider }),
  checks: [...input.checks],
  skipped: [...input.skipped],
  summary: summarizeDoctorChecks(input.checks),
});

/** The one completion policy: self failures fail the command, findings exit 1. */
export const doctorCompletion = (
  report: DoctorReport,
): { readonly ok: boolean; readonly exitCode: 0 | 1 } => {
  const selfFailed = report.checks.some((check) => check.name === DOCTOR_SELF_CHECK_NAME);
  return { ok: !selfFailed, exitCode: report.summary.failed > 0 ? 1 : 0 };
};
