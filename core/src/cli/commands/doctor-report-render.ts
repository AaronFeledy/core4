import { Schema } from "effect";

import { emitLandofileYaml } from "@lando/sdk/landofile";
import type { ConfigLintResult } from "@lando/sdk/schema";

import {
  type SummaryDocument,
  type SummaryRow,
  type SummarySection,
  type SummaryTone,
  formatSummary,
  worstSummaryTone,
} from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext } from "../renderer-boundary";
import { renderConfigLintViolation } from "./config-lint-rendering";
import type { DoctorDeprecationReport, DoctorReport } from "./doctor-report-contract";
import { DoctorReportSchema } from "./doctor-report-contract";
import type { DoctorSelfReport } from "./doctor-self";
export { renderDoctorReportAsNdjson } from "./doctor-report-ndjson";
import { renderDoctorResult, renderSolution } from "./doctor";
import { renderGlobalAppDoctorResult } from "./doctor-global-app";
import { renderMcpDoctorResult } from "./doctor-mcp";
import { renderSubsystemDoctorResult } from "./doctor-subsystems";
import { renderAppVersionConstraintResult } from "./doctor-version-constraint";

interface DoctorCheckLike {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<{
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

const selfSection = (report: DoctorSelfReport): SummarySection => ({
  title: "doctor self",
  rows: report.checks.map((check) => ({
    label: check.section,
    tone: "error",
    value: check.reason,
    fields: Object.entries(check.context).map(([label, value]) => ({ label, value })),
    detail: check.solutions.map((solution) => solution.description).join(" · "),
  })),
  notes: ["These sections could not be diagnosed; the rest of this report is unaffected."],
});

const countByStatus = (report: DoctorReport): { readonly checks: number; readonly failed: number } => {
  const checks = [
    ...report.provider.checks,
    ...report.subsystems.checks,
    ...report.globalApp.checks,
    ...report.mcp.checks,
    ...(report.appVersionConstraints?.checks ?? []),
  ];
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  const selfChecks = report.self?.checks ?? [];
  return {
    checks: checks.length + (report.appConfig === undefined ? 0 : 1) + selfChecks.length,
    failed:
      checks.filter((check) => check.status === "fail").length +
      (appConfigInvalid ? 1 : 0) +
      selfChecks.length,
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
    sections.push(checkSection("app version constraint", report.appVersionConstraints.checks));
  if (report.deprecations !== undefined) sections.push(deprecationsSection(report.deprecations));
  if (report.appConfig !== undefined) sections.push(appConfigSection(report.appConfig));
  if (report.self !== undefined) sections.push(selfSection(report.self));
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

const renderSelfSection = (report: DoctorSelfReport): string => {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.name}: ${check.status}`);
    lines.push(`section: ${check.section}`);
    lines.push(`reason: ${check.reason}`);
    for (const [field, value] of Object.entries(check.context)) {
      if (field === "section" || field === "reason") continue;
      lines.push(`${field}: ${value}`);
    }
    for (const solution of check.solutions) {
      lines.push(renderSolution(solution));
    }
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
  const self = report.self === undefined ? "" : renderSelfSection(report.self);
  const parts = [
    provider,
    subsystems,
    globalApp,
    mcp,
    appVersionConstraints,
    deprecations,
    appConfig,
    self,
  ].filter((part) => part.length > 0);
  return parts.join("\n");
};

export const renderDoctorReportAsYaml = (report: DoctorReport): string =>
  emitLandofileYaml(Object.fromEntries(Object.entries(Schema.encodeSync(DoctorReportSchema)(report))));
