import {
  encodeStreamEventFrame,
  encodeStreamResultFrame,
  identityRedactor,
  resolveCommandCompletion,
} from "@lando/sdk/command-result";

import type { ConfigLintResult } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { renderDoctorResultAsNdjson } from "./doctor";
import { renderGlobalAppDoctorResultAsNdjson } from "./doctor-global-app";
import { renderMcpDoctorResultAsNdjson } from "./doctor-mcp";
import { DoctorNdjsonSummarySchema } from "./doctor-ndjson";
import type { DoctorDeprecationReport, DoctorReport } from "./doctor-report-contract";
import { countDoctorChecks } from "./doctor-report-counts";
import type { DoctorSelfCheck } from "./doctor-self";
import { renderSubsystemDoctorResultAsNdjson } from "./doctor-subsystems";
import { appVersionConstraintCheckPayload } from "./doctor-version-constraint";

const doctorCheckFrameLine = (payload: Record<string, unknown>): string =>
  Effect.runSync(encodeStreamEventFrame({ event: "doctor.check", payload, redactor: identityRedactor }));

const appConfigCheckLine = (result: ConfigLintResult): string => {
  const warnings = result.violations.filter((issue) => issue.severity === "warning");
  return doctorCheckFrameLine({
    _tag: "doctor.check",
    name: "app-config-lint",
    status: result.valid ? (warnings.length > 0 ? "warn" : "pass") : "fail",
    severity: result.valid ? (warnings.length > 0 ? "warn" : "info") : "error",
    context: {
      file: result.file,
      valid: String(result.valid),
      violations: String(result.violations.length),
      warnings: String(warnings.length),
    },
    violations: result.violations,
  });
};

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
  readonly now?: Date | DateTime.DateTime;
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
  const instant = options.now === undefined ? DateTime.nowUnsafe() : DateTime.makeUnsafe(options.now);
  const timestamp = DateTime.formatIso(instant);
  const now = DateTime.toDateUtc(instant);
  const lines: string[] = [];
  if (report.globalConfig !== undefined)
    lines.push(doctorCheckFrameLine({ name: "global-config", ...report.globalConfig }));
  for (const skipped of report.skipped ?? [])
    lines.push(doctorCheckFrameLine({ name: skipped.section, ...skipped }));
  lines.push(
    ...checkLinesFromNdjson(renderDoctorResultAsNdjson(report.provider, { now })),
    ...(report.appListeners === undefined
      ? []
      : checkLinesFromNdjson(renderDoctorResultAsNdjson(report.appListeners, { now }))),
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
  const { checks, failed, warned } = countDoctorChecks(report);
  const summary = {
    timestamp,
    checks,
    failed,
    warned,
  };
  lines.push(
    Effect.runSync(
      encodeStreamResultFrame({
        command: "meta:doctor",
        resultSchema: DoctorNdjsonSummarySchema,
        outcome: resolveCommandCompletion("meta:doctor", summary, () => ({
          ok: report.self === undefined,
          exitCode: report.self === undefined && summary.failed === 0 ? 0 : 1,
        })),
        redactor: identityRedactor,
      }),
    ),
  );
  return lines.join("\n");
};
