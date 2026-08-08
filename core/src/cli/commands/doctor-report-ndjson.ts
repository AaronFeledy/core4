import { Effect } from "effect";

import type { ConfigLintResult } from "@lando/sdk/schema";

import { encodeStreamEventFrame, encodeStreamResultFrame, identityRedactor } from "../result-encode";
import { renderDoctorResultAsNdjson } from "./doctor";
import { renderGlobalAppDoctorResultAsNdjson } from "./doctor-global-app";
import { renderMcpDoctorResultAsNdjson } from "./doctor-mcp";
import { DoctorNdjsonSummarySchema } from "./doctor-ndjson";
import type { DoctorDeprecationReport, DoctorReport } from "./doctor-report-contract";
import type { DoctorSelfCheck } from "./doctor-self";
import { renderSubsystemDoctorResultAsNdjson } from "./doctor-subsystems";
import { appVersionConstraintCheckPayload } from "./doctor-version-constraint";

const doctorCheckFrameLine = (payload: Record<string, unknown>): string =>
  Effect.runSync(encodeStreamEventFrame({ event: "doctor.check", payload, redactor: identityRedactor }));

const appConfigCheckLine = (result: ConfigLintResult): string =>
  doctorCheckFrameLine({
    _tag: "doctor.check",
    name: "app-config-lint",
    status: result.valid ? "pass" : "fail",
    severity: result.valid ? "info" : "error",
    context: {
      file: result.file,
      valid: String(result.valid),
      violations: String(result.violations.length),
    },
    violations: result.violations,
  });

const deprecationsCheckLine = (result: DoctorDeprecationReport): string =>
  doctorCheckFrameLine({
    _tag: "doctor.check",
    name: "deprecations",
    status: "pass",
    severity: "info",
    context: { entries: String(result.entries.length) },
    entries: result.entries,
  });

const selfCheckLine = (check: DoctorSelfCheck): string =>
  doctorCheckFrameLine({
    _tag: "doctor.check",
    name: check.name,
    status: check.status,
    severity: check.severity,
    section: check.section,
    reason: check.reason,
    context: check.context,
    solutions: check.solutions,
  });

export interface DoctorReportNdjsonOptions {
  readonly now?: Date;
}

const checkLinesFromNdjson = (ndjson: string): ReadonlyArray<string> =>
  ndjson
    .trimEnd()
    .split("\n")
    .filter((line) => (JSON.parse(line) as { readonly _tag?: unknown })._tag === "event");

export const renderDoctorReportAsNdjson = (
  report: DoctorReport,
  options: DoctorReportNdjsonOptions = {},
): string => {
  const timestamp = (options.now ?? new Date()).toISOString();
  const now = new Date(timestamp);
  const lines: string[] = [];
  lines.push(
    ...checkLinesFromNdjson(renderDoctorResultAsNdjson(report.provider, { now })),
    ...checkLinesFromNdjson(renderSubsystemDoctorResultAsNdjson(report.subsystems, { now })),
    ...checkLinesFromNdjson(renderGlobalAppDoctorResultAsNdjson(report.globalApp, { now })),
    ...checkLinesFromNdjson(renderMcpDoctorResultAsNdjson(report.mcp, { now })),
  );
  if (report.appVersionConstraints !== undefined)
    lines.push(
      ...report.appVersionConstraints.checks.map((check) =>
        doctorCheckFrameLine(appVersionConstraintCheckPayload(check)),
      ),
    );
  if (report.deprecations !== undefined) lines.push(deprecationsCheckLine(report.deprecations));
  if (report.appConfig !== undefined) lines.push(appConfigCheckLine(report.appConfig));
  const selfChecks = report.self?.checks ?? [];
  lines.push(...selfChecks.map(selfCheckLine));
  const checks = [
    ...report.provider.checks,
    ...report.subsystems.checks,
    ...report.globalApp.checks,
    ...report.mcp.checks,
    ...(report.appVersionConstraints?.checks ?? []),
  ];
  const deprecationsCheckCount = report.deprecations === undefined ? 0 : 1;
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  const summary = {
    timestamp,
    checks:
      checks.length + deprecationsCheckCount + (report.appConfig === undefined ? 0 : 1) + selfChecks.length,
    failed:
      checks.filter((check) => check.status === "fail").length +
      (appConfigInvalid ? 1 : 0) +
      selfChecks.length,
    warned: checks.filter((check) => check.status === "warn").length,
  };
  lines.push(
    Effect.runSync(
      encodeStreamResultFrame({
        command: "meta:doctor",
        resultSchema: DoctorNdjsonSummarySchema,
        outcome: { _tag: "success", value: summary },
        redactor: identityRedactor,
      }),
    ),
  );
  return `${lines.join("\n")}\n`;
};
