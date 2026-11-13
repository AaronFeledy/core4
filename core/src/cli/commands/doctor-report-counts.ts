import type { DoctorReport } from "./doctor-report-contract";
import type { DoctorTextCheck } from "./doctor-text-model";

export const allDoctorChecks = (report: DoctorReport): ReadonlyArray<DoctorTextCheck> => [
  ...report.provider.checks,
  ...(report.appListeners?.checks ?? []),
  ...report.subsystems.checks,
  ...report.globalApp.checks,
  ...report.mcp.checks,
  ...(report.appVersionConstraints?.checks ?? []),
];

export const countDoctorChecks = (
  report: DoctorReport,
): {
  readonly checks: number;
  readonly passed: number;
  readonly failed: number;
  readonly warned: number;
} => {
  const checks = allDoctorChecks(report);
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  const appConfigWarned = report.appConfig?.violations.some((issue) => issue.severity === "warning") === true;
  const selfChecks = report.self?.checks ?? [];
  const deprecations = report.deprecations?.entries ?? [];
  return {
    checks:
      checks.length + (report.appConfig === undefined ? 0 : 1) + selfChecks.length + deprecations.length,
    passed:
      checks.filter((check) => check.status === "pass").length +
      (report.appConfig?.valid === true && !appConfigWarned ? 1 : 0) +
      deprecations.filter((entry) => entry.severity === "info").length,
    failed:
      checks.filter((check) => check.status === "fail").length +
      (appConfigInvalid ? 1 : 0) +
      selfChecks.length +
      deprecations.filter((entry) => entry.severity === "error").length,
    warned:
      checks.filter((check) => check.status === "warn").length +
      deprecations.filter((entry) => entry.severity === "warn").length +
      (appConfigWarned ? 1 : 0),
  };
};
