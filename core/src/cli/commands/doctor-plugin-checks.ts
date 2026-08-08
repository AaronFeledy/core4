/**
 * Plugin-contributed doctor checks.
 *
 * Each `doctorChecks:` contribution is untrusted host code, so it runs under its
 * own deadline with defect capture and `plugin-check:<id>` attribution. A
 * hanging or throwing contribution degrades to one attributed self check and
 * cannot take the doctor run down.
 */
import { Effect, Either, Schema } from "effect";

import type { LandoPluginModule, PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import {
  type HostPlatform,
  PluginDoctorReport,
  type ProviderCapabilities as ProviderCapabilitiesShape,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";

import { makePluginCapabilityIndex } from "@lando/engine/plugins/module-set";
import type { DoctorCheck, DoctorSelectionRecord } from "./doctor-contract";
import { providerKindFor } from "./doctor-contract";
import {
  type DoctorSelfCheck,
  type DoctorSelfSolution,
  describeDoctorFailure,
  doctorSelfCheck,
  isolateDoctorSection,
  redactDoctorMessage,
} from "./doctor-self";

export interface PluginDoctorInput {
  readonly providerId: string;
  readonly platform: HostPlatform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataRoot: string | undefined;
  readonly binDir: string | undefined;
  readonly stateDir: string | undefined;
}

export interface PluginDoctorProvider {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
}

interface PluginDoctorCheckMapping {
  readonly report: PluginDoctorReport;
  readonly provider: PluginDoctorProvider;
  readonly selection: DoctorSelectionRecord;
}

interface PluginDoctorContributionReport {
  readonly report: PluginDoctorReport;
  readonly relevant: PluginDoctorCheckContribution["relevant"];
}

export interface PluginDoctorRunOutcome {
  readonly reports: ReadonlyArray<PluginDoctorContributionReport>;
  readonly selfChecks: ReadonlyArray<DoctorSelfCheck>;
}

/**
 * Provider- and plugin-shaped probes get a tighter default than a whole report
 * section, and shrink further when the section budget is lowered.
 */
const PROBE_BUDGET_MS = 5_000;
const MAX_REPORTS_PER_CHECK = 32;
const PluginDoctorReports = Schema.Array(PluginDoctorReport).pipe(Schema.maxItems(MAX_REPORTS_PER_CHECK));

class PluginDoctorReportInvalidError extends Schema.TaggedError<PluginDoctorReportInvalidError>()(
  "PluginDoctorReportInvalidError",
  { message: Schema.String },
) {}

export const probeBudgetMs = (sectionBudgetMs: number): number =>
  Math.min(PROBE_BUDGET_MS, Math.floor(sectionBudgetMs / 3));

const PLUGIN_CHECK_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "A plugin-contributed doctor check did not complete. Remove or update the owning plugin (`lando plugin remove <name>`) if it keeps failing; the rest of this report is unaffected.",
};

const PLUGIN_INDEX_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Plugin doctor contributions could not be indexed, so no plugin checks ran. Inspect installed plugins with `lando plugin list` and remove the conflicting one.",
};

export const pluginDoctorReports = (
  modules: ReadonlyArray<LandoPluginModule>,
  input: PluginDoctorInput,
  redactor: Redactor,
  budgetMs: number,
): Effect.Effect<PluginDoctorRunOutcome, never> =>
  Effect.gen(function* () {
    const index = makePluginCapabilityIndex(modules);
    if (Either.isLeft(index)) {
      const described = describeDoctorFailure(index.left);
      return {
        reports: [],
        selfChecks: [
          doctorSelfCheck({
            section: "plugin-doctor-checks",
            reason: "failure",
            message: redactDoctorMessage(described.message, redactor.redactString),
            ...(described.tag === undefined ? {} : { tag: described.tag }),
            solutions: [PLUGIN_INDEX_REMEDIATION],
          }),
        ],
      };
    }

    const isolated = yield* Effect.forEach(
      index.right.doctorChecks.entries(),
      ([id, check]) =>
        isolateDoctorSection({
          section: `plugin-check:${id}`,
          // Suspended so a synchronous throw while *building* the effect is
          // attributed to the plugin rather than escaping the isolate.
          effect: Effect.suspend(() => check.run(input)).pipe(
            Effect.flatMap((reports) =>
              Schema.decodeUnknown(PluginDoctorReports, { onExcessProperty: "error" })(reports).pipe(
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
                Effect.flatMap(Schema.decodeUnknown(PluginDoctorReports)),
                Effect.mapError(
                  () =>
                    new PluginDoctorReportInvalidError({
                      message: `Plugin doctor check returned an invalid payload. Reports are limited to ${MAX_REPORTS_PER_CHECK} entries; update the owning plugin to satisfy PluginDoctorReport.`,
                    }),
                ),
              ),
            ),
          ),
          fallback: [] as ReadonlyArray<PluginDoctorReport>,
          budgetMs,
          redact: redactor.redactString,
          context: { checkId: id },
          solutions: [PLUGIN_CHECK_REMEDIATION],
        }).pipe(Effect.map((outcome) => ({ outcome, relevant: check.relevant }))),
      { concurrency: "unbounded" },
    );

    return {
      reports: isolated.flatMap((entry) =>
        entry.outcome.value.map((report) => ({ report, relevant: entry.relevant })),
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

export const mapPluginDoctorCheck = ({
  report,
  provider,
  selection,
}: PluginDoctorCheckMapping): DoctorCheck => ({
  name: report.name,
  status: report.status,
  severity: report.severity,
  providerId: provider.id,
  providerName: provider.displayName,
  providerVersion: provider.version,
  providerKind: providerKindFor(provider.id),
  runtimeStatus: report.runtimeStatus ?? "unknown",
  runtime:
    report.runtime === undefined
      ? { running: report.status === "pass" }
      : {
          running: report.runtime.running,
          ...(report.runtime.version === undefined ? {} : { version: report.runtime.version }),
        },
  capabilities: {},
  context: report.context,
  solutions: report.solutions.map((solution) => ({
    kind: solution.kind,
    description: solution.description,
    ...(solution.command === undefined ? {} : { command: solution.command }),
  })),
  selection,
});
