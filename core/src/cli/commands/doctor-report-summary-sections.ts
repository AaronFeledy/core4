import type { SummaryField, SummarySection } from "@lando/renderer/summary";
import type { ConfigLintResult } from "@lando/sdk/schema";
import { renderConfigLintViolations } from "./config-lint-rendering";
import { renderSolution } from "./doctor-render-text";
import type { DoctorDeprecationReport } from "./doctor-report-contract";
import type { DoctorSelfReport } from "./doctor-self";
import { type DoctorRenderOptions, doctorContextValue } from "./doctor-text-model";

const optionalField = (label: string, value: string | undefined): ReadonlyArray<SummaryField> =>
  value === undefined || value === "" ? [] : [{ label, value }];

export const deprecationsSection = (report: DoctorDeprecationReport): SummarySection => ({
  title: "deprecations",
  rows: report.entries.map((entry) => ({
    label: `${entry.kind} ${entry.id}`,
    tone: entry.severity === "error" ? "error" : entry.severity === "warn" ? "warn" : "info",
    value: `${entry.count} ${entry.count === 1 ? "use" : "uses"}`,
    fields: [
      { label: "since", value: entry.since },
      ...optionalField("removeIn", entry.removeIn),
      ...optionalField("replacement", entry.replacement),
      ...optionalField("docsUrl", entry.docsUrl),
      { label: "source", value: entry.source },
    ],
    remedy: entry.note,
  })),
  ...(report.entries.length === 0 ? { notes: ["No deprecations in use."] } : {}),
});

export const appConfigSection = (
  result: ConfigLintResult,
  options: DoctorRenderOptions,
): SummarySection | undefined => {
  if (result.valid && result.violations.length === 0)
    return options.all === true
      ? {
          title: "app config",
          rows: [
            {
              label: "app-config-lint",
              tone: "ok",
              value: "pass",
              fields: [{ label: "file", value: result.file }],
            },
          ],
        }
      : undefined;
  return {
    title: "app config",
    rows: [
      {
        label: "app-config-lint",
        value: result.valid ? "warn" : "fail",
        tone: result.valid ? "warn" : "error",
        fields: [{ label: "file", value: result.file }],
      },
    ],
    notes: renderConfigLintViolations(result.violations, result.file),
  };
};

export const selfSection = (report: DoctorSelfReport, options: DoctorRenderOptions): SummarySection => ({
  title: "doctor self",
  rows: report.checks.map((check) => ({
    label: check.name,
    tone: "error",
    value: check.status,
    fields: [
      { label: "section", value: check.section },
      { label: "reason", value: check.reason },
      ...Object.entries(check.context)
        .filter(([label]) => label !== "section" && label !== "reason")
        .map(([label, value]) => ({ label, value: doctorContextValue(label, value, options.all) })),
    ],
    remedy: check.solutions.map(renderSolution).join("\n"),
  })),
  notes: ["These sections could not be diagnosed; the rest of this report is unaffected."],
});
