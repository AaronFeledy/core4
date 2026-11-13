import { mapFailures } from "@lando/sdk/command-result";
import type { PluginDoctorCheckContribution, PluginDoctorCheckInput } from "@lando/sdk/plugins";
import {
  PluginDoctorReport,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
/**
 * Plugin-contributed doctor checks.
 *
 * Each `doctorChecks:` contribution is untrusted host code, so it runs under its
 * own deadline with defect capture and `plugin-check:<id>` attribution. A
 * hanging or throwing contribution degrades to one attributed self check and
 * cannot take the doctor run down.
 */
import { Effect, Schema } from "effect";

import type { DoctorFinding, DoctorSolution } from "./doctor-contract";
import { DOCTOR_SELF_CHECK_NAME } from "./doctor-contract";
import { type DoctorSelfFinding, isolateDoctorSection } from "./doctor-self";

export interface PluginDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
}

interface PluginDoctorCheckMapping {
  readonly report: PluginDoctorReport;
  readonly contributor: string;
}

interface PluginDoctorContributionReport {
  readonly report: PluginDoctorReport;
  readonly relevant: PluginDoctorCheckContribution["relevant"];
  readonly contributor: string;
}

export interface PluginDoctorRunOutcome {
  readonly reports: ReadonlyArray<PluginDoctorContributionReport>;
  readonly selfChecks: ReadonlyArray<DoctorSelfFinding>;
}

/**
 * Provider- and plugin-shaped probes get a tighter default than a whole report
 * section, and shrink further when the section budget is lowered.
 */
const PROBE_BUDGET_MS = 5_000;
const MAX_REPORTS_PER_CHECK = 32;
const PluginDoctorReports = Schema.Array(PluginDoctorReport).pipe(
  Schema.check(Schema.isMaxLength(MAX_REPORTS_PER_CHECK)),
);

class PluginDoctorReportInvalidError extends Schema.TaggedError<PluginDoctorReportInvalidError>()(
  "PluginDoctorReportInvalidError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export const probeBudgetMs = (sectionBudgetMs: number): number =>
  Math.min(PROBE_BUDGET_MS, Math.floor(sectionBudgetMs / 3));

const PLUGIN_CHECK_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "A plugin-contributed doctor check did not complete. Remove or update the owning plugin (`lando plugin:remove <name>`) if it keeps failing; the rest of this report is unaffected.",
};

const PLUGIN_INDEX_REMEDIATION: DoctorSolution = {
  kind: "manual",
  description:
    "Plugin doctor contributions could not be indexed, so no plugin checks ran. Use the reported plugin identity to repair its doctor contributions or remove it with `lando plugin:remove <name>` and reinstall it with `lando plugin:add <spec>`.",
};

export const pluginDoctorReports = Effect.fnUntraced(function* (
  index: Effect.Effect<ReadonlyMap<string, PluginDoctorCheckContribution>, unknown>,
  input: PluginDoctorCheckInput,
  redactor: Redactor,
  budgetMs: number,
): Effect.fn.Return<PluginDoctorRunOutcome, never> {
  const indexed = yield* isolateDoctorSection({
    section: "provider",
    probe: "plugin-doctor-checks",
    effect: index,
    fallback: new Map<string, PluginDoctorCheckContribution>(),
    budgetMs,
    redact: redactor.redactString,
    solutions: [PLUGIN_INDEX_REMEDIATION],
  });
  if (indexed.self !== undefined) return { reports: [], selfChecks: [indexed.self] };

  const isolated = yield* Effect.forEach(
    indexed.value.entries(),
    ([id, check]) =>
      isolateDoctorSection({
        section: "provider",
        probe: `plugin-check:${id}`,
        // Suspended so a synchronous throw while *building* the effect is
        // attributed to the plugin rather than escaping the isolate.
        effect: Effect.suspend(() => check.run(input)).pipe(
          Effect.flatMap((reports) =>
            Schema.decodeUnknownEffect(PluginDoctorReports, { onExcessProperty: "error" })(reports).pipe(
              Effect.map((decoded) =>
                decoded.map((report) =>
                  redactor.redactValue({
                    ...report,
                    context: Object.fromEntries(
                      Object.entries(report.context).map(([key, value]) => [
                        redactor.redactString(key),
                        value,
                      ]),
                    ),
                  }),
                ),
              ),
              Effect.flatMap(Schema.decodeUnknownEffect(PluginDoctorReports)),
              mapFailures(
                () =>
                  new PluginDoctorReportInvalidError({
                    message: `Plugin doctor check returned an invalid payload. Reports are limited to ${MAX_REPORTS_PER_CHECK} entries; update the owning plugin to satisfy PluginDoctorReport.`,
                    remediation: `Update the owning plugin so its doctor check returns at most ${MAX_REPORTS_PER_CHECK} PluginDoctorReport entries with a valid shape, or remove the plugin with \`lando plugin:remove <name>\`.`,
                  }),
              ),
              Effect.flatMap((reports) =>
                reports.some((report) => report.name === DOCTOR_SELF_CHECK_NAME)
                  ? Effect.fail(
                      new PluginDoctorReportInvalidError({
                        message: `Plugin doctor check returned a reserved ${DOCTOR_SELF_CHECK_NAME} report, which only doctor itself may produce.`,
                        remediation: `Rename the plugin's doctor check; ${DOCTOR_SELF_CHECK_NAME} is reserved for doctor's own machinery failures.`,
                      }),
                    )
                  : Effect.succeed(reports),
              ),
            ),
          ),
        ),
        fallback: [] as ReadonlyArray<PluginDoctorReport>,
        budgetMs,
        redact: redactor.redactString,
        context: { checkId: id },
        solutions: [PLUGIN_CHECK_REMEDIATION],
      }).pipe(Effect.map((outcome) => ({ outcome, relevant: check.relevant, contributor: id }))),
    { concurrency: "unbounded" },
  );

  return {
    reports: isolated.flatMap((entry) =>
      entry.outcome.value.map((report) => ({
        report,
        relevant: entry.relevant,
        contributor: entry.contributor,
      })),
    ),
    selfChecks: isolated.flatMap((entry) => (entry.outcome.self === undefined ? [] : [entry.outcome.self])),
  };
});

/**
 * A plugin's `relevant` predicate is untrusted host code called outside the
 * per-check isolate, so a throw here must drop the contribution rather than
 * collapse the whole provider section.
 */
export const isRelevantContribution = (
  entry: PluginDoctorContributionReport,
  capabilities: ProviderCapabilitiesShape,
): boolean => {
  if (entry.relevant === undefined) return true;
  try {
    return entry.relevant(capabilities) === true;
  } catch {
    return false;
  }
};

export const mapPluginDoctorCheck = ({ report, contributor }: PluginDoctorCheckMapping): DoctorFinding => ({
  name: report.name,
  ...(report.subject === undefined ? {} : { subject: report.subject }),
  status: report.status,
  severity: report.severity,
  ...(report.runtimeStatus === undefined ? {} : { runtimeStatus: report.runtimeStatus }),
  ...(report.runtime === undefined ? {} : { runtime: report.runtime }),
  context: report.context,
  solutions: report.solutions,
  contributor,
});
