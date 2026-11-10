import {
  type SummaryDocument,
  type SummarySection,
  type SummaryTone,
  formatRailSummary,
} from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import type { DoctorReport } from "./doctor-report-contract";
import { allDoctorChecks, countDoctorChecks } from "./doctor-report-counts";
import { appConfigSection, deprecationsSection, selfSection } from "./doctor-report-summary-sections";
import { type DoctorRenderOptions, doctorCheckSection, doctorNextSteps } from "./doctor-text-model";

export { countDoctorChecks } from "./doctor-report-counts";
export { renderDoctorReportAsNdjson } from "./doctor-report-ndjson";
export type { DoctorRenderOptions } from "./doctor-text-model";

const doctorFooter = (counts: ReturnType<typeof countDoctorChecks>, options: DoctorRenderOptions): string => {
  const warningLabel = counts.warned === 1 ? "warning" : "warnings";
  const totals =
    counts.failed === 0 && counts.warned === 0
      ? `${counts.checks} checks passed`
      : counts.warned === 0
        ? `${counts.checks} checks · ${counts.failed} failed`
        : `${counts.checks} checks · ${counts.failed} failed · ${counts.warned} ${warningLabel}`;
  return options.all === true || counts.passed === 0
    ? totals
    : `${totals} · lando doctor --all lists every check`;
};

const doctorTone = (counts: ReturnType<typeof countDoctorChecks>): SummaryTone => {
  if (counts.failed > 0) return "error";
  if (counts.warned > 0) return "warn";
  return counts.checks === 0 ? "info" : "ok";
};

const providerHeader = (report: DoctorReport): ReadonlyArray<string> => {
  const provider =
    report.provider.checks.find((check) => check.name === "selected-provider") ?? report.provider.checks[0];
  if (provider === undefined) return [];
  return [
    `provider: ${provider.providerId}`,
    `providerName: ${provider.providerName}`,
    `providerVersion: ${provider.providerVersion}`,
    `providerKind: ${provider.providerKind}`,
    `runtimeStatus: ${provider.runtimeStatus}`,
    ...(provider.runtime.version === undefined ? [] : [`runtimeVersion: ${provider.runtime.version}`]),
    ...(provider.selection === undefined
      ? []
      : [
          `selectionSource: ${provider.selection.source}`,
          ...Object.entries(provider.selection.inputs).map(
            ([key, value]) =>
              `selectionInput${key === "capabilityDefault" ? "Default" : key[0]?.toUpperCase() + key.slice(1)}: ${value}`,
          ),
        ]),
  ];
};

export const buildDoctorReportSummary = (
  report: DoctorReport,
  options: DoctorRenderOptions = {},
): SummaryDocument => {
  const sections: SummarySection[] = [];
  const push = (section: SummarySection | undefined): void => {
    if (section !== undefined) sections.push(section);
  };
  if (report.globalConfig !== undefined && (options.all === true || report.globalConfig.status !== "pass"))
    push({
      title: "global-config",
      rows: [
        {
          label: "global-config",
          value: report.globalConfig.status,
          tone: report.globalConfig.status === "pass" ? "ok" : "error",
        },
      ],
      ...(report.globalConfig.error === undefined
        ? {}
        : {
            notes: [
              report.globalConfig.error.message,
              report.globalConfig.error.remediation ?? "lando config validate",
            ],
          }),
    });
  const skipped = [
    ...(report.skipped ?? []),
    ...(report.provider.skipped ?? []),
    ...(report.subsystems.skipped ?? []),
  ];
  if (skipped.length > 0)
    push({
      title: "skipped",
      rows: skipped.map((entry) => ({
        label: entry.section,
        value: "SKIPPED",
        tone: "skipped",
        fields: [{ label: "reason", value: entry.reason }],
      })),
    });
  push(doctorCheckSection("provider", report.provider.checks, options));
  if (report.appListeners !== undefined)
    push(doctorCheckSection("app-listeners", report.appListeners.checks, options));
  push(doctorCheckSection("subsystems", report.subsystems.checks, options));
  push(doctorCheckSection("global app", report.globalApp.checks, options));
  push(doctorCheckSection("mcp", report.mcp.checks, options));
  if (report.appVersionConstraints !== undefined)
    push(doctorCheckSection("app version constraint", report.appVersionConstraints.checks, options));
  if (report.deprecations !== undefined && (options.all === true || report.deprecations.entries.length > 0))
    push(deprecationsSection(report.deprecations));
  if (report.appConfig !== undefined) push(appConfigSection(report.appConfig, options));
  if (report.self !== undefined) push(selfSection(report.self, options));
  const counts = countDoctorChecks(report);
  const tone = doctorTone(counts);
  const header = [...(report.version ? [`version: ${report.version}`] : []), ...providerHeader(report)];
  const steps = doctorNextSteps(allDoctorChecks(report), options);
  return {
    title: tone === "error" ? "Problems found" : tone === "warn" ? "Needs attention" : "Healthy",
    tone,
    ...(header.length === 0 ? {} : { subtitle: header.join(" · ") }),
    sections,
    ...(steps.length === 0 ? {} : { nextSteps: steps }),
    footer: doctorFooter(counts, options),
  };
};

export const renderDoctorReport = (
  report: DoctorReport,
  ctx?: RenderContext,
  options: DoctorRenderOptions = {},
): string => {
  const document = buildDoctorReportSummary(report, options);
  if (isDecoratedContext(ctx)) return `\n${formatRailSummary(document, summaryPaintOptions(ctx))}`;
  const lines = [...(report.version ? [`version: ${report.version}`] : []), ...providerHeader(report)];
  for (const section of document.sections) {
    if (section.title === "deprecations" && report.deprecations !== undefined) {
      lines.push(
        "deprecations:",
        "kind | id | severity | since | removeIn | replacement | note | docsUrl | source | count",
      );
      for (const entry of report.deprecations.entries)
        lines.push(
          [
            entry.kind,
            entry.id,
            entry.severity,
            entry.since,
            entry.removeIn ?? "-",
            entry.replacement ?? "-",
            entry.note,
            entry.docsUrl ?? "-",
            entry.source,
            String(entry.count),
          ].join(" | "),
        );
      if (report.deprecations.entries.length === 0)
        lines.push("No deprecations were used or triggered at runtime for the app.");
      continue;
    }
    lines.push(`${section.title}:`);
    for (const row of section.rows) {
      lines.push(`${row.label}: ${row.value ?? ""}`);
      for (const field of row.fields ?? []) lines.push(`${field.label}: ${field.value}`);
      if (row.remedy !== undefined) lines.push(row.remedy);
    }
    lines.push(...(section.notes ?? []));
  }
  if (document.nextSteps !== undefined) lines.push("next steps:", ...document.nextSteps);
  if (document.footer !== undefined) lines.push(document.footer);
  return lines.join("\n");
};
