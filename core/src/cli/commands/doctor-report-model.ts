import { CORE_VERSION } from "@lando/engine/version";
import type {
  DoctorProvider,
  DoctorReport,
  DoctorSectionFinding,
  DoctorSkip,
  DoctorSummary,
} from "./doctor-contract";
import { DOCTOR_SELF_CHECK_NAME } from "./doctor-contract";

export const summarizeDoctorChecks = (checks: ReadonlyArray<DoctorSectionFinding>): DoctorSummary => {
  const counts = { pass: 0, warn: 0, fail: 0 };
  let selfFailed = 0;
  for (const check of checks) {
    counts[check.status]++;
    if (check.name === DOCTOR_SELF_CHECK_NAME) selfFailed++;
  }
  return {
    checks: checks.length,
    passed: counts.pass,
    warned: counts.warn,
    failed: counts.fail,
    selfFailed,
  };
};

export const makeDoctorReport = (input: {
  readonly version?: string | undefined;
  readonly provider?: DoctorProvider | undefined;
  readonly checks: ReadonlyArray<DoctorSectionFinding>;
  readonly skipped: ReadonlyArray<DoctorSkip>;
}): DoctorReport => {
  const used = new Set<string>();
  const checks = input.checks.map((check) => {
    const base = `${check.section}/${check.name}${check.subject === undefined ? "" : `/${check.subject}`}`;
    let id = base;
    let occurrence = 1;
    while (used.has(id)) id = `${base}#${++occurrence}`;
    used.add(id);
    return { ...check, id };
  });
  return {
    version: input.version ?? CORE_VERSION,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    checks,
    skipped: [...input.skipped],
    summary: summarizeDoctorChecks(input.checks),
  };
};

/**
 * The one completion policy: self failures fail the command, findings exit 1.
 * It reads only `summary`, which describes the whole run, so a filtered or
 * paged view cannot change the outcome.
 */
export const doctorCompletion = (
  report: DoctorReport,
): { readonly ok: boolean; readonly exitCode: 0 | 1 } => ({
  ok: report.summary.selfFailed === 0,
  exitCode: report.summary.failed > 0 ? 1 : 0,
});
