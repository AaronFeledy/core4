import { Schema } from "effect";

import { emitLandofileYaml } from "@lando/sdk/landofile";
import type { ConfigLintResult } from "@lando/sdk/schema";

import type { RenderContext } from "../renderer-boundary.ts";
import { isDecoratedContext } from "../renderer-boundary.ts";
import {
  type SummaryDocument,
  type SummaryRow,
  type SummarySection,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "../renderer/summary.ts";
import { renderConfigLintViolation } from "./config-lint-rendering.ts";
import type { DoctorDeprecationReport, DoctorReport } from "./doctor-report-contract.ts";
import { DoctorReportSchema } from "./doctor-report-contract.ts";
export { renderDoctorReportAsNdjson } from "./doctor-report-ndjson.ts";
import { renderGlobalAppDoctorResult } from "./doctor-global-app.ts";
import { renderMcpDoctorResult } from "./doctor-mcp.ts";
import { renderSubsystemDoctorResult } from "./doctor-subsystems.ts";
import {
  type AppVersionConstraintDoctorResult,
  renderAppVersionConstraintResult,
} from "./doctor-version-constraint.ts";
import { renderDoctorResult } from "./doctor.ts";

interface DoctorCheckLike {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{
    readonly kind: string;
    readonly description: string;
    readonly command?: string;
  }>;
}

const doctorStatusTone = (status: DoctorCheckLike["status"]): SummaryTone =>
  status === "pass" ? "ok" : status === "warn" ? "warn" : "error";

const checkToRow = (check: DoctorCheckLike): SummaryRow => {
  const solutions = check.solutions.map(
    (solution) => `${solution.description}${solution.command === undefined ? "" : ` (${solution.command})`}`,
  );
  return {
    label: check.name,
    tone: doctorStatusTone(check.status),
    value: check.status,
    fields: Object.entries(check.context).map(([label, value]) => ({ label, value })),
    ...(solutions.length === 0 ? {} : { detail: solutions.join(" · ") }),
  };
};

const checkSection = (title: string, checks: ReadonlyArray<DoctorCheckLike>): SummarySection => ({
  title,
  rows: checks.map(checkToRow),
  ...(checks.length === 0 ? { notes: ["No checks reported."] } : {}),
});

const valueOrDash = (value: string | undefined): string =>
  value === undefined || value === "" ? "-" : value;

const deprecationsSection = (report: DoctorDeprecationReport): SummarySection => ({
  title: "deprecations",
  rows: report.entries.map((entry) => ({
    label: `${entry.kind} ${entry.id}`,
    tone: entry.severity === "error" ? "error" : entry.severity === "warn" ? "warn" : "info",
    value: `${entry.count} ${entry.count === 1 ? "use" : "uses"}`,
    fields: [
      { label: "since", value: entry.since },
      { label: "removeIn", value: valueOrDash(entry.removeIn) },
      { label: "replacement", value: valueOrDash(entry.replacement) },
      { label: "source", value: entry.source },
    ],
    detail: entry.note,
  })),
  ...(report.entries.length === 0
    ? { notes: ["No deprecations were used or triggered at runtime for the app."] }
    : {}),
});

const appConfigSection = (result: ConfigLintResult): SummarySection => ({
  title: "app config",
  rows: [
    {
      label: "lint",
      tone: result.valid ? "ok" : "error",
      value: result.valid ? "pass" : "fail",
      fields: [{ label: "file", value: result.file }],
    },
  ],
  ...(result.violations.length === 0 ? {} : { notes: result.violations.map(renderConfigLintViolation) }),
});

const appVersionConstraintSection = (result: AppVersionConstraintDoctorResult): SummarySection =>
  checkSection("app version constraint", result.checks);

const countByStatus = (report: DoctorReport): { readonly checks: number; readonly failed: number } => {
  const checks = [
    ...report.provider.checks,
    ...report.subsystems.checks,
    ...report.globalApp.checks,
    ...report.mcp.checks,
    ...(report.appVersionConstraints?.checks ?? []),
  ];
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  return {
    checks: checks.length + (report.appConfig === undefined ? 0 : 1),
    failed: checks.filter((check) => check.status === "fail").length + (appConfigInvalid ? 1 : 0),
  };
};

export const buildDoctorReportSummary = (report: DoctorReport): SummaryDocument => {
  const sections: SummarySection[] = [
    checkSection("provider", report.provider.checks),
    checkSection("subsystems", report.subsystems.checks),
    checkSection("global app", report.globalApp.checks),
    checkSection("mcp", report.mcp.checks),
  ];
  if (report.appVersionConstraints !== undefined)
    sections.push(appVersionConstraintSection(report.appVersionConstraints));
  if (report.deprecations !== undefined) sections.push(deprecationsSection(report.deprecations));
  if (report.appConfig !== undefined) sections.push(appConfigSection(report.appConfig));
  const counts = countByStatus(report);
  const rowTones = sections.flatMap((section) => section.rows.map((row) => row.tone ?? "info"));
  return {
    title: "DOCTOR",
    tone: rowTones.length === 0 ? "info" : worstSummaryTone(rowTones),
    sections,
    footer: `${counts.checks} checks · ${counts.failed} failed`,
  };
};

const renderDeprecationsSection = (report: DoctorDeprecationReport): string => {
  const lines = ["deprecations:"];
  if (report.entries.length === 0) {
    lines.push("No deprecations were used or triggered at runtime for the app.");
    return lines.join("\n");
  }
  lines.push("kind | id | severity | since | removeIn | replacement | note | docsUrl | source | count");
  for (const entry of report.entries) {
    lines.push(
      [
        entry.kind,
        entry.id,
        entry.severity,
        entry.since,
        valueOrDash(entry.removeIn),
        valueOrDash(entry.replacement),
        entry.note,
        valueOrDash(entry.docsUrl),
        entry.source,
        String(entry.count),
      ].join(" | "),
    );
  }
  return lines.join("\n");
};

const renderAppConfigSection = (result: ConfigLintResult): string => {
  const lines = [`app-config-lint: ${result.valid ? "pass" : "fail"}`, `file: ${result.file}`];
  lines.push(...result.violations.map(renderConfigLintViolation));
  return lines.join("\n");
};

export const renderDoctorReport = (report: DoctorReport, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return formatSummary(buildDoctorReportSummary(report), { columns: ctx?.columns });
  const provider = renderDoctorResult(report.provider);
  const subsystems = renderSubsystemDoctorResult(report.subsystems);
  const globalApp = renderGlobalAppDoctorResult(report.globalApp);
  const mcp = renderMcpDoctorResult(report.mcp);
  const appVersionConstraints =
    report.appVersionConstraints === undefined
      ? ""
      : renderAppVersionConstraintResult(report.appVersionConstraints);
  const deprecations =
    report.deprecations === undefined ? "" : renderDeprecationsSection(report.deprecations);
  const appConfig = report.appConfig === undefined ? "" : renderAppConfigSection(report.appConfig);
  const parts = [provider, subsystems, globalApp, mcp, appVersionConstraints, deprecations, appConfig].filter(
    (part) => part.length > 0,
  );
  return parts.join("\n");
};

export const renderDoctorReportAsYaml = (report: DoctorReport): string =>
  emitLandofileYaml(Object.fromEntries(Object.entries(Schema.encodeSync(DoctorReportSchema)(report))));
