import type { ConfigLintResult } from "@lando/sdk/schema";

import {
  type SummaryDocument,
  type SummaryField,
  type SummaryRow,
  type SummarySection,
  type SummaryTone,
  formatRailSummary,
} from "@lando/renderer/summary";
import type { RenderContext } from "../renderer-boundary";
import { isDecoratedContext, summaryPaintOptions } from "../renderer-boundary";
import { renderConfigLintViolation } from "./config-lint-rendering";
import type { DoctorDeprecationReport, DoctorReport } from "./doctor-report-contract";
import type { DoctorSelfReport } from "./doctor-self";
export { renderDoctorReportAsNdjson } from "./doctor-report-ndjson";
import { renderDoctorResult, renderSolution } from "./doctor";
import { renderGlobalAppDoctorResult } from "./doctor-global-app";
import { renderMcpDoctorResult } from "./doctor-mcp";
import { renderSubsystemDoctorResult } from "./doctor-subsystems";
import { renderAppVersionConstraintResult } from "./doctor-version-constraint";

interface DoctorSolutionLike {
  readonly description: string;
  readonly command?: string;
}

interface DoctorCheckLike {
  readonly name: string;
  readonly status: "pass" | "warn" | "fail";
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolutionLike>;
}

/**
 * Context keys every check in a section repeats (provider identity, subsystem
 * name). The provider identity already heads the document and the subsystem
 * name is the row label, so listing them per row is noise.
 */
const BOILERPLATE_CONTEXT_KEYS = new Set([
  "providerId",
  "providerKind",
  "providerVersion",
  "platform",
  "subsystem",
]);

const MAX_LISTED_GROUP_VALUES = 6;

/** Render options for the decorated report. */
export interface DoctorRenderOptions {
  /** List passing checks too; by default only degraded checks are shown. */
  readonly all?: boolean | undefined;
}

const doctorStatusTone = (status: DoctorCheckLike["status"]): SummaryTone =>
  status === "pass" ? "ok" : status === "warn" ? "warn" : "error";

/** The command the reader just ran; a check that says "re-run doctor" adds nothing. */
const DOCTOR_COMMAND = "lando doctor";

/**
 * One remedy line: the description, plus the command when the description
 * does not already spell it out.
 */
const solutionText = (solution: DoctorSolutionLike): string => {
  const command = solution.command;
  if (
    command === undefined ||
    command.length === 0 ||
    command === DOCTOR_COMMAND ||
    solution.description.includes(command)
  ) {
    return solution.description;
  }
  return `${solution.description} Run \`${command}\`.`;
};

const remedyText = (solutions: ReadonlyArray<DoctorSolutionLike>): string | undefined =>
  solutions.length === 0 ? undefined : solutions.map(solutionText).join(" ");

const solutionsKey = (solutions: ReadonlyArray<DoctorSolutionLike>): string =>
  solutions.map(solutionText).join("\u0000");

/**
 * Adjacent checks with the same name, status, and remediation are one finding
 * repeated per app (host-proxy-transport is emitted once per app), so they
 * collapse into one row that lists the varying values.
 */
const groupChecks = (
  checks: ReadonlyArray<DoctorCheckLike>,
): ReadonlyArray<ReadonlyArray<DoctorCheckLike>> => {
  const groups: DoctorCheckLike[][] = [];
  for (const check of checks) {
    const last = groups[groups.length - 1];
    const head = last?.[0];
    if (
      last !== undefined &&
      head !== undefined &&
      head.name === check.name &&
      head.status === check.status &&
      solutionsKey(head.solutions) === solutionsKey(check.solutions)
    ) {
      last.push(check);
    } else {
      groups.push([check]);
    }
  }
  return groups;
};

const listValues = (values: ReadonlyArray<string>): string => {
  const unique = [...new Set(values)];
  if (unique.length <= MAX_LISTED_GROUP_VALUES) return unique.join(", ");
  const shown = unique.slice(0, MAX_LISTED_GROUP_VALUES);
  return `${shown.join(", ")} (+${unique.length - shown.length} more)`;
};

/**
 * Fields for a degraded row: context that is constant across the group once,
 * plus the first varying key (the per-app identity) as a list. Other varying
 * keys stay in structured output, where a script can read them per check.
 */
const groupFields = (group: ReadonlyArray<DoctorCheckLike>): ReadonlyArray<SummaryField> => {
  const head = group[0];
  if (head === undefined) return [];
  const fields: SummaryField[] = [];
  let listed = false;
  for (const [label, value] of Object.entries(head.context)) {
    if (BOILERPLATE_CONTEXT_KEYS.has(label)) continue;
    const values = group.map((check) => check.context[label] ?? "");
    if (values.every((candidate) => candidate === value)) {
      fields.push({ label, value });
    } else if (!listed) {
      fields.push({ label, value: listValues(values) });
      listed = true;
    }
  }
  return fields;
};

const groupToRow = (group: ReadonlyArray<DoctorCheckLike>): SummaryRow => {
  const head = group[0];
  if (head === undefined) throw new Error("doctor summary group cannot be empty");
  const tone = doctorStatusTone(head.status);
  if (head.status === "pass") return { label: head.name, tone, value: "pass" };
  const fields = groupFields(group);
  const remedy = remedyText(head.solutions);
  return {
    label: head.name,
    tone,
    ...(group.length === 1 ? {} : { value: `${group.length}×` }),
    ...(fields.length === 0 ? {} : { fields }),
    ...(remedy === undefined ? {} : { remedy }),
  };
};

/**
 * A section of the decorated report. By default only degraded checks make a
 * row and a section with none is omitted; `--all` lists every check.
 */
const checkSection = (
  title: string,
  checks: ReadonlyArray<DoctorCheckLike>,
  options: DoctorRenderOptions,
): SummarySection | undefined => {
  if (options.all === true) {
    return {
      title,
      rows: groupChecks(checks).map(groupToRow),
      ...(checks.length === 0 ? { notes: ["No checks reported."] } : {}),
    };
  }
  const degraded = checks.filter((check) => check.status !== "pass");
  if (degraded.length === 0) return undefined;
  return { title, rows: groupChecks(degraded).map(groupToRow) };
};

const valueOrDash = (value: string | undefined): string =>
  value === undefined || value === "" ? "-" : value;

const optionalField = (label: string, value: string | undefined): ReadonlyArray<SummaryField> =>
  value === undefined || value === "" ? [] : [{ label, value }];

const deprecationsSection = (report: DoctorDeprecationReport): SummarySection => ({
  title: "deprecations",
  rows: report.entries.map((entry) => ({
    label: `${entry.kind} ${entry.id}`,
    tone: entry.severity === "error" ? "error" : entry.severity === "warn" ? "warn" : "info",
    value: `${entry.count} ${entry.count === 1 ? "use" : "uses"}`,
    fields: [
      { label: "since", value: entry.since },
      ...optionalField("removeIn", entry.removeIn),
      ...optionalField("replacement", entry.replacement),
      { label: "source", value: entry.source },
    ],
    remedy: entry.note,
  })),
  ...(report.entries.length === 0 ? { notes: ["No deprecations in use."] } : {}),
});

const appConfigSection = (
  result: ConfigLintResult,
  options: DoctorRenderOptions,
): SummarySection | undefined => {
  if (result.valid) {
    return options.all === true
      ? { title: "app config", rows: [{ label: "lint", tone: "ok", value: "pass" }] }
      : undefined;
  }
  return {
    title: "app config",
    rows: [{ label: "lint", tone: "error", fields: [{ label: "file", value: result.file }] }],
    notes: result.violations.map(renderConfigLintViolation),
  };
};

const selfSection = (report: DoctorSelfReport): SummarySection => ({
  title: "doctor self",
  rows: report.checks.map((check) => ({
    label: check.section,
    tone: "error",
    value: check.reason,
    fields: Object.entries(check.context)
      .filter(([label]) => label !== "section" && label !== "reason")
      .map(([label, value]) => ({ label, value })),
    remedy: check.solutions.map((solution) => solution.description).join(" "),
  })),
  notes: ["These sections could not be diagnosed; the rest of this report is unaffected."],
});

const allChecks = (report: DoctorReport): ReadonlyArray<DoctorCheckLike> => [
  ...report.provider.checks,
  ...report.subsystems.checks,
  ...report.globalApp.checks,
  ...report.mcp.checks,
  ...(report.appVersionConstraints?.checks ?? []),
];

/** Distinct remediation commands from degraded checks, in report order. */
const nextSteps = (report: DoctorReport): ReadonlyArray<string> => {
  const commands = new Set<string>();
  for (const check of allChecks(report)) {
    if (check.status === "pass") continue;
    for (const solution of check.solutions) {
      const command = solution.command;
      if (command === undefined || command.length === 0 || command === DOCTOR_COMMAND) continue;
      commands.add(command);
    }
  }
  return [...commands];
};

/** Check, failure, and warning totals across every report section. */
export const countDoctorChecks = (
  report: DoctorReport,
): { readonly checks: number; readonly failed: number; readonly warned: number } => {
  const checks = allChecks(report);
  const appConfigInvalid = report.appConfig !== undefined && !report.appConfig.valid;
  const selfChecks = report.self?.checks ?? [];
  const deprecations = report.deprecations?.entries ?? [];
  const deprecationWarnings = deprecations.filter((entry) => entry.severity === "warn").length;
  const deprecationErrors = deprecations.filter((entry) => entry.severity === "error").length;
  return {
    checks: checks.length + (report.appConfig === undefined ? 0 : 1) + selfChecks.length,
    failed:
      checks.filter((check) => check.status === "fail").length +
      (appConfigInvalid ? 1 : 0) +
      selfChecks.length +
      deprecationErrors,
    warned: checks.filter((check) => check.status === "warn").length + deprecationWarnings,
  };
};

const ALL_HINT = "lando doctor --all lists every check";

const doctorFooter = (
  counts: { readonly checks: number; readonly failed: number; readonly warned: number },
  options: DoctorRenderOptions,
): string => {
  const warningLabel = counts.warned === 1 ? "warning" : "warnings";
  const totals =
    counts.failed === 0 && counts.warned === 0
      ? `${counts.checks} checks passed`
      : counts.warned === 0
        ? `${counts.checks} checks · ${counts.failed} failed`
        : `${counts.checks} checks · ${counts.failed} failed · ${counts.warned} ${warningLabel}`;
  const hidden = counts.checks - counts.failed - counts.warned;
  return options.all === true || hidden <= 0 ? totals : `${totals} · ${ALL_HINT}`;
};

const doctorTitle = (tone: SummaryTone): string => {
  switch (tone) {
    case "error":
      return "Problems found";
    case "warn":
    case "pending":
    case "skipped":
      return "Needs attention";
    case "ok":
    case "info":
      return "Healthy";
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
};

const doctorSubtitle = (report: DoctorReport): string => {
  const parts: string[] = [];
  if (report.version !== undefined && report.version !== "") parts.push(`Lando ${report.version}`);
  const provider = report.provider.checks[0];
  if (provider !== undefined) {
    parts.push(`provider ${provider.providerId} (${provider.providerKind})`);
    if (provider.runtime.version !== undefined) parts.push(`runtime ${provider.runtime.version}`);
  }
  return parts.join(" · ");
};

/** Title tone from the same totals the tree summary and footer use, so all three agree. */
const doctorTone = (counts: ReturnType<typeof countDoctorChecks>): SummaryTone => {
  if (counts.failed > 0) return "error";
  if (counts.warned > 0) return "warn";
  return counts.checks === 0 ? "info" : "ok";
};

export const buildDoctorReportSummary = (
  report: DoctorReport,
  options: DoctorRenderOptions = {},
): SummaryDocument => {
  const sections: SummarySection[] = [];
  const push = (section: SummarySection | undefined): void => {
    if (section !== undefined) sections.push(section);
  };
  push(checkSection("provider", report.provider.checks, options));
  push(checkSection("subsystems", report.subsystems.checks, options));
  push(checkSection("global app", report.globalApp.checks, options));
  push(checkSection("mcp", report.mcp.checks, options));
  if (report.appVersionConstraints !== undefined)
    push(checkSection("app version constraint", report.appVersionConstraints.checks, options));
  if (report.deprecations !== undefined && (options.all === true || report.deprecations.entries.length > 0))
    push(deprecationsSection(report.deprecations));
  if (report.appConfig !== undefined) push(appConfigSection(report.appConfig, options));
  if (report.self !== undefined) push(selfSection(report.self));
  const counts = countDoctorChecks(report);
  const tone = doctorTone(counts);
  const subtitle = doctorSubtitle(report);
  const steps = nextSteps(report);
  return {
    title: doctorTitle(tone),
    tone,
    ...(subtitle.length === 0 ? {} : { subtitle }),
    sections,
    ...(steps.length === 0 ? {} : { nextSteps: steps }),
    footer: doctorFooter(counts, options),
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

export const renderDoctorReport = (
  report: DoctorReport,
  ctx?: RenderContext,
  options: DoctorRenderOptions = {},
): string => {
  if (isDecoratedContext(ctx))
    return `\n${formatRailSummary(buildDoctorReportSummary(report, options), summaryPaintOptions(ctx))}`;
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
  const version = report.version === undefined || report.version === "" ? "" : `version: ${report.version}`;
  const parts = [
    version,
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
