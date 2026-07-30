/**
 * Plugin-contributed doctor checks.
 *
 * Each `doctorChecks:` contribution is untrusted host code, so it runs under its
 * own deadline with defect capture and `plugin-check:<id>` attribution. A
 * hanging or throwing contribution degrades to one attributed self check and
 * cannot take the doctor run down.
 */
import { Effect, Either } from "effect";

import type {
  LandoPluginModule,
  PluginDoctorCheckContribution,
  PluginDoctorReport,
} from "@lando/sdk/plugins";
import type { HostPlatform, ProviderCapabilities as ProviderCapabilitiesShape } from "@lando/sdk/schema";

import { makePluginCapabilityIndex } from "../../plugins/module-set.ts";
import type { DoctorCheck, DoctorSelectionRecord } from "./doctor-contract.ts";
import { providerKindFor } from "./doctor-contract.ts";
import {
  type DoctorSelfCheck,
  type DoctorSelfSolution,
  describeDoctorFailure,
  doctorSelfCheck,
  isolateDoctorSection,
} from "./doctor-self.ts";

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

export const probeBudgetMs = (sectionBudgetMs: number): number => Math.min(PROBE_BUDGET_MS, sectionBudgetMs);

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
  redact: (value: string) => string,
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
            message: redact(described.message),
            ...(described.tag === undefined ? {} : { tag: described.tag }),
            solutions: [PLUGIN_INDEX_REMEDIATION],
          }),
        ],
      };
    }

    const isolated = yield* Effect.forEach(index.right.doctorChecks.entries(), ([id, check]) =>
      isolateDoctorSection({
        section: `plugin-check:${id}`,
        // Suspended so a synchronous throw while *building* the effect is
        // attributed to the plugin rather than escaping the isolate.
        effect: Effect.suspend(() => check.run(input)),
        fallback: [] as ReadonlyArray<PluginDoctorReport>,
        budgetMs,
        redact,
        context: { checkId: id },
        solutions: [PLUGIN_CHECK_REMEDIATION],
      }).pipe(Effect.map((outcome) => ({ outcome, relevant: check.relevant }))),
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
  runtime: report.runtime ?? { running: report.status === "pass" },
  capabilities: {},
  context: report.context,
  solutions: report.solutions,
  selection,
});
