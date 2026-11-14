import { shellArg } from "@lando/engine/services/shell-quote";
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
import type { DoctorCheck, DoctorReport, DoctorSolution } from "./doctor-contract";
import { DOCTOR_SECTION_IDS, DOCTOR_SELF_CHECK_NAME } from "./doctor-contract";
import { capabilitiesSection, providerHeader, skippedSection } from "./doctor-render-metadata";

export interface DoctorRenderOptions {
  readonly all?: boolean | undefined;
  /** CLI arguments that reproduce the run's selection, repeated in the paging continuation. */
  readonly selection?: ReadonlyArray<string> | undefined;
}

const doctorContextValue = (value: string | ReadonlyArray<string>, all = false): string => {
  const items = typeof value === "string" ? [value] : value;
  if (all) return items.join(", ");
  const shown = items.slice(0, 3).map((item) => (item.length > 240 ? `${item.slice(0, 240)}...` : item));
  return `${shown.join(", ")}${items.length > 3 ? ` (+${items.length - 3} more)` : ""}`;
};

const solutionText = (solution: DoctorSolution): string => {
  const command = solution.command;
  return command === undefined ||
    command.length === 0 ||
    command === "lando doctor" ||
    solution.description.includes(command)
    ? solution.description
    : `${solution.description} Run \`${command}\`.`;
};

export const renderSolution = (solution: DoctorSolution): string => {
  const command = solution.command === undefined ? "" : ` (${solution.command})`;
  return `solution[${solution.kind}]: ${solution.description}${command}`;
};

const groupChecks = (
  checks: ReadonlyArray<DoctorCheck>,
): ReadonlyArray<readonly [DoctorCheck, ...DoctorCheck[]]> => {
  const groups = new Map<string, [DoctorCheck, ...DoctorCheck[]]>();
  for (const check of checks) {
    const key = JSON.stringify([check.contributor ?? check.section, check.name, check.status]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [check]);
    else group.push(check);
  }
  return [...groups.values()];
};

const groupRemedy = (group: readonly [DoctorCheck, ...DoctorCheck[]]): string | undefined => {
  const variants = new Set(group.map((check) => JSON.stringify(check.solutions)));
  const head = group[0];
  if (variants.size === 1)
    return head.solutions.length === 0 ? undefined : head.solutions.map(solutionText).join(" ");
  const common = [
    ...new Set(head.solutions.flatMap((solution) => (solution.command ? [solution.command] : []))),
  ].filter((command) =>
    group.every((check) => check.solutions.some((solution) => solution.command === command)),
  );
  return [
    `${variants.size} remediation variants (lando doctor --all)`,
    ...common.map((command) => `Run \`${command}\`.`),
  ].join(" ");
};

const groupFields = (
  group: readonly [DoctorCheck, ...DoctorCheck[]],
  all: boolean,
): ReadonlyArray<SummaryField> => {
  const head = group[0];
  const fields: SummaryField[] = [];
  if (all) {
    fields.push({ label: "severity", value: head.severity });
    if (head.runtimeStatus !== undefined) fields.push({ label: "runtimeStatus", value: head.runtimeStatus });
    if (head.runtime?.message !== undefined)
      fields.push({ label: "runtimeMessage", value: head.runtime.message });
    if (head.runtime?.version !== undefined)
      fields.push({ label: "runtimeVersion", value: head.runtime.version });
  }
  if (group.length > 1) {
    const identities = group.slice(0, 3).map((check) => doctorContextValue(check.subject ?? check.name));
    fields.push({ label: "entries", value: identities.join("; ") });
    if (group.length > 3)
      fields.push({ label: "remaining", value: `+${group.length - 3} more (lando doctor --all)` });
  } else if (head.subject !== undefined)
    fields.push({ label: "subject", value: doctorContextValue(head.subject, all) });
  for (const [label, value] of Object.entries(head.context)) {
    if (
      group.length > 1 &&
      !group.every((check) => JSON.stringify(check.context[label]) === JSON.stringify(value))
    )
      continue;
    fields.push({ label, value: doctorContextValue(value, all) });
  }
  return fields;
};

const selfRow = (check: DoctorCheck, all: boolean): SummaryRow => ({
  label: check.name,
  tone: "error",
  value: check.status,
  fields: [
    ...(check.subject === undefined
      ? []
      : [{ label: "subject", value: doctorContextValue(check.subject, all) }]),
    ...["probe", "reason", "message"].flatMap((label) => {
      const value = check.context[label];
      return value === undefined ? [] : [{ label, value: doctorContextValue(value, all) }];
    }),
    ...Object.entries(check.context)
      .filter(([label]) => label !== "probe" && label !== "reason" && label !== "message")
      .map(([label, value]) => ({ label, value: doctorContextValue(value, all) })),
  ],
  remedy: check.solutions.map(renderSolution).join("\n"),
});

export const doctorCheckSection = (
  title: string,
  checks: ReadonlyArray<DoctorCheck>,
  options: DoctorRenderOptions,
): SummarySection | undefined => {
  const all = options.all === true;
  const visible = all ? checks : checks.filter((check) => check.status !== "pass");
  const grouped = visible.filter((check) => check.name !== DOCTOR_SELF_CHECK_NAME);
  const selfChecks = visible.filter((check) => check.name === DOCTOR_SELF_CHECK_NAME);
  const groups: ReadonlyArray<readonly [DoctorCheck, ...DoctorCheck[]]> = all
    ? grouped.map((check): readonly [DoctorCheck] => [check])
    : groupChecks(grouped);
  const rows: SummaryRow[] = groups.map((group) => {
    const head = group[0];
    const remedy = all ? head.solutions.map(renderSolution).join("\n") : groupRemedy(group);
    return {
      label: head.name,
      tone: head.status === "pass" ? "ok" : head.status === "warn" ? "warn" : "error",
      value: group.length === 1 ? head.status : `${head.status} (${group.length} checks)`,
      fields: groupFields(group, all),
      ...(remedy ? { remedy } : {}),
    };
  });
  rows.push(...selfChecks.map((check) => selfRow(check, all)));
  if (rows.length === 0) return undefined;
  return { title, rows };
};

const doctorNextSteps = (
  checks: ReadonlyArray<DoctorCheck>,
  options: DoctorRenderOptions,
): ReadonlyArray<string> => {
  const commands = new Set<string>();
  const names = new Set<string>();
  for (const check of checks) {
    if (check.status === "pass" || (options.all !== true && names.has(check.name))) continue;
    for (const solution of check.solutions) {
      const command = solution.command;
      if (!command || command === "lando doctor" || commands.has(command)) continue;
      commands.add(command);
      names.add(check.name);
      if (options.all !== true) break;
    }
  }
  return [...commands];
};

const countsFooter = (report: DoctorReport, options: DoctorRenderOptions): string => {
  const { summary } = report;
  const totals =
    summary.failed === 0 && summary.warned === 0
      ? `${summary.checks} checks passed`
      : summary.warned === 0
        ? `${summary.checks} checks · ${summary.failed} failed`
        : `${summary.checks} checks · ${summary.failed} failed · ${summary.warned} ${
            summary.warned === 1 ? "warning" : "warnings"
          }`;
  return options.all === true || summary.passed === 0
    ? totals
    : `${totals} · lando doctor --all lists every check`;
};

const doctorTone = (report: DoctorReport): SummaryTone => {
  if (report.summary.failed > 0) return "error";
  if (report.summary.warned > 0) return "warn";
  return report.summary.checks === 0 ? "info" : "ok";
};

export const buildDoctorReportSummary = (
  report: DoctorReport,
  options: DoctorRenderOptions = {},
): SummaryDocument => {
  const sections: SummarySection[] = [];
  const skipped = skippedSection(report);
  if (skipped !== undefined) sections.push(skipped);
  for (const id of DOCTOR_SECTION_IDS) {
    // Deprecation notices list in full even without --all: an info notice is the
    // only signal that a surface is going away.
    const section = doctorCheckSection(
      id,
      report.checks.filter((check) => check.section === id),
      id === "deprecations" ? { all: true } : options,
    );
    if (section !== undefined) sections.push(section);
  }
  if (options.all === true) {
    const capabilities = capabilitiesSection(report.provider);
    if (capabilities !== undefined) sections.push(capabilities);
  }
  const tone = doctorTone(report);
  const header = [`version: ${report.version}`, ...providerHeader(report.provider)];
  const steps = [...doctorNextSteps(report.checks, options)];
  if (report.page?.next !== undefined) {
    const args = [
      "--format=json",
      ...(options.selection ?? []),
      "--limit",
      String(report.page.limit),
      "--after",
      report.page.next,
    ];
    steps.push(`lando doctor ${args.map((arg) => shellArg(arg)).join(" ")}`);
  }
  return {
    title: tone === "error" ? "Problems found" : tone === "warn" ? "Needs attention" : "Healthy",
    tone,
    subtitle: header.join(" · "),
    sections,
    ...(steps.length === 0 ? {} : { nextSteps: steps }),
    footer: countsFooter(report, options),
  };
};

export const renderDoctorReport = (
  report: DoctorReport,
  ctx?: RenderContext,
  options: DoctorRenderOptions = {},
): string => {
  const document = buildDoctorReportSummary(report, options);
  if (isDecoratedContext(ctx)) return `\n${formatRailSummary(document, summaryPaintOptions(ctx))}`;
  const lines = [`version: ${report.version}`, ...providerHeader(report.provider)];
  for (const section of document.sections) {
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
