import { Context, Effect } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
import type { DoctorOptions, DoctorSectionResult } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import type {
  DoctorProvider,
  DoctorReport,
  DoctorSectionFinding,
  DoctorSectionId,
  DoctorSkip,
} from "./doctor-contract";
import {
  type DoctorSectionOutcome,
  checksOutcome,
  doctorTreeSummary,
  makeDoctorTree,
  settleDoctorSection,
} from "./doctor-progress";
import { makeDoctorReport } from "./doctor-report-model";
import {
  type DoctorContexts,
  type DoctorSection,
  type DoctorSectionSpec,
  doctorSections,
  selectedDoctorSections,
} from "./doctor-sections";
import { doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";
import { resolveSecretsRedactor } from "./secrets-redactor";

export type { DoctorReport } from "./doctor-contract";
export { DoctorReportSchema } from "./doctor-contract";
export { renderDoctorReportAsNdjson } from "./doctor-render-ndjson";
export { type DoctorRenderOptions, buildDoctorReportSummary, renderDoctorReport } from "./doctor-render-text";
export { doctorCompletion, makeDoctorReport, summarizeDoctorChecks } from "./doctor-report-model";

export interface DoctorSectionOutput {
  readonly checks: ReadonlyArray<DoctorSectionFinding>;
  readonly skipped: ReadonlyArray<DoctorSkip>;
  readonly provider?: DoctorProvider;
}

const stampSection = (section: DoctorSectionId, result: DoctorSectionResult): DoctorSectionOutput => ({
  checks: result.checks.map((finding) => ({ section, ...finding })),
  skipped: (result.skipped ?? []).map((skip) => ({ section, ...skip })),
  ...(result.provider === undefined ? {} : { provider: result.provider }),
});

const runDoctorSection = <R>(
  spec: DoctorSectionSpec<R>,
  input: { readonly budgetMs: number; readonly redact: (value: string) => string },
): Effect.Effect<DoctorSectionOutput, never, R> =>
  spec.isolate === false
    ? spec.run.pipe(Effect.map((result) => stampSection(spec.id, result)))
    : isolateDoctorSection({
        section: spec.id,
        effect: spec.run,
        fallback: { checks: [] } satisfies DoctorSectionResult,
        budgetMs: input.budgetMs,
        redact: input.redact,
      }).pipe(
        Effect.map((isolated) => {
          const output = stampSection(spec.id, isolated.value);
          return isolated.self === undefined
            ? output
            : { ...output, checks: [...output.checks, isolated.self] };
        }),
      );

export interface CollectDoctorReportInput {
  readonly options: DoctorOptions;
  readonly contexts: DoctorContexts;
  readonly initialChecks?: ReadonlyArray<DoctorSectionFinding>;
  readonly table?: ReadonlyArray<DoctorSection>;
}

const unavailable = (id: DoctorSectionId, reason: string): Effect.Effect<DoctorSectionOutput> =>
  Effect.succeed({ checks: [], skipped: [{ section: id, reason }] });

const collectSection = (
  spec: DoctorSection,
  contexts: DoctorContexts,
  input: Parameters<typeof runDoctorSection>[1],
) => {
  const configReason = "Requires a valid global config; see the global-config check.";
  switch (spec.requires) {
    case "none":
      return runDoctorSection(spec, input).pipe(
        Effect.provide(contexts.runtime ?? contexts.config ?? Context.empty()),
      );
    case "config": {
      const context = contexts.runtime ?? contexts.config;
      return context === undefined
        ? unavailable(spec.id, configReason)
        : runDoctorSection(spec, input).pipe(Effect.provide(context));
    }
    case "runtime": {
      if (contexts.runtime !== undefined)
        return runDoctorSection(spec, input).pipe(Effect.provide(contexts.runtime));
      return unavailable(
        spec.id,
        contexts.config === undefined
          ? configReason
          : "Requires the provider runtime; see the provider-bootstrap check.",
      );
    }
    default: {
      const unreachable: never = spec;
      return unreachable;
    }
  }
};

export const collectDoctorReport = Effect.fn("Doctor.collectReport")(
  (input: CollectDoctorReportInput): Effect.Effect<DoctorReport> =>
    collectWithTree(input).pipe((effect) => interruptOnAbort(effect, input.options.signal)),
);

const collectWithTree = Effect.fnUntraced(function* (input: CollectDoctorReportInput) {
  const options = input.options;
  const sourceEnv = { ...(options.env ?? (yield* CliInvocation).env) };
  const { redact } = yield* resolveSecretsRedactor({ sourceEnv }).pipe(
    Effect.provide(input.contexts.runtime ?? input.contexts.config ?? Context.empty()),
  );
  const budgetMs = doctorSectionBudgetMs(sourceEnv);
  const initial = input.initialChecks ?? [];
  const checks: DoctorSectionFinding[] = [...initial];
  const skipped: DoctorSkip[] = [];
  const table = input.table ?? doctorSections({ options, sourceEnv, budgetMs, redact });
  const enabled = selectedDoctorSections(table, options);
  // Bootstrap's global-config finding gets the first row, so a config problem is visible live.
  const configChecks = initial.filter((check) => check.section === "global-config");
  const configRow: ReadonlyArray<DoctorSectionId> = configChecks.length === 0 ? [] : ["global-config"];
  const tree = yield* makeDoctorTree([...configRow, ...enabled.map((spec) => spec.id)]);
  return yield* Effect.gen(function* () {
    yield* tree.start;
    if (configChecks.length > 0) {
      yield* tree.startTask("global-config");
      yield* settleDoctorSection(
        tree,
        "global-config",
        sectionOutcomeFor("global-config", { checks: configChecks, skipped: [] }),
      );
    }
    let provider: DoctorProvider | undefined;
    for (const spec of enabled) {
      yield* tree.startTask(spec.id);
      const output = yield* collectSection(spec, input.contexts, { budgetMs, redact });
      if (spec.id === "provider") provider = output.provider;
      checks.push(...output.checks);
      skipped.push(...output.skipped);
      // Findings recorded before collection (a provider-bootstrap self check) settle their section's row too.
      const prior = initial.filter((check) => check.section === spec.id);
      yield* settleDoctorSection(
        tree,
        spec.id,
        sectionOutcomeFor(spec.id, { ...output, checks: [...prior, ...output.checks] }),
      );
    }
    const report = makeDoctorReport({ provider, checks, skipped });
    yield* tree.close(doctorTreeSummary(report.summary));
    return report;
  }).pipe(Effect.onInterrupt(() => tree.settleInterrupt("doctor · interrupted")));
});

const sectionOutcomeFor = (id: DoctorSectionId, output: DoctorSectionOutput): DoctorSectionOutcome => {
  if (output.checks.length === 0 && output.skipped.length > 0)
    return { summary: `${id} · skipped`, skipped: true };
  return checksOutcome(id, output.checks);
};
