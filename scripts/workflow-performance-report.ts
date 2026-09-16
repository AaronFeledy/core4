import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { Schema } from "effect";

import { ImagePullFailureDiagnosticSchema } from "../core/src/cli/failure-diagnostic.ts";
import {
  WORKFLOW_PERFORMANCE_LANE_IDS,
  WORKFLOW_PERFORMANCE_STEP_IDS,
  isWorkflowPerformanceSampleKey,
  workflowPerformanceSampleKey,
} from "./workflow-performance-identifiers.ts";

const EVIDENCE_LIMIT = 12_000;
const MAX_LANES = 16;
const MAX_SAMPLES = 10;
const MAX_STEPS = 16;
const OMITTED_DIAGNOSTIC = "[diagnostic evidence omitted]";

const OutcomeSchema = Schema.Literal("passed", "failed", "skipped");
const SeriesSchema = Schema.Struct({
  provider: Schema.String,
  platform: Schema.String,
  fixtureSet: Schema.String,
});
const RunSchema = Schema.Struct({
  id: Schema.String,
  attempt: Schema.Number,
  commit: Schema.String,
  generatedAt: Schema.String,
  architecture: Schema.String,
  runner: Schema.String,
});
const VersionsSchema = Schema.Struct({
  binary: Schema.String,
  runtime: Schema.String,
  provider: Schema.String,
});
const FixtureSchema = Schema.Struct({
  family: Schema.Literal("mysql", "postgres"),
  version: Schema.String,
  seed: Schema.String,
  rowCount: Schema.Number,
  bytes: Schema.Number,
  sha256: Schema.String,
});
const StepSchema = Schema.Struct({
  id: Schema.Literal(...WORKFLOW_PERFORMANCE_STEP_IDS),
  durationMs: Schema.Number,
  exitCode: Schema.Number,
  stdout: Schema.String.pipe(Schema.maxLength(EVIDENCE_LIMIT + "\n[truncated]".length)),
  stderr: Schema.String.pipe(Schema.maxLength(EVIDENCE_LIMIT + "\n[truncated]".length)),
  diagnostic: Schema.optional(ImagePullFailureDiagnosticSchema),
});
const SampleSchema = Schema.Struct({
  index: Schema.Int.pipe(Schema.between(0, MAX_SAMPLES - 1)),
  key: Schema.String,
  outcome: OutcomeSchema,
  resetCondition: Schema.String,
  stagedFixture: Schema.optional(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
  steps: Schema.Array(StepSchema).pipe(Schema.maxItems(MAX_STEPS)),
  skipReason: Schema.optional(Schema.String),
});
const StatisticsSchema = Schema.Struct({
  successfulSamples: Schema.Number,
  minMs: Schema.Number,
  medianMs: Schema.Number,
  p95Ms: Schema.Number,
  maxMs: Schema.Number,
});
const LaneSchema = Schema.Struct({
  id: Schema.Literal(...WORKFLOW_PERFORMANCE_LANE_IDS),
  class: Schema.Literal("start", "heavy"),
  outcome: OutcomeSchema,
  samples: Schema.Array(SampleSchema).pipe(Schema.maxItems(MAX_SAMPLES)),
  statistics: Schema.optional(StatisticsSchema),
  skipReason: Schema.optional(Schema.String),
});

const WorkflowPerformanceReportStruct = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.optional(Schema.Literal("running", "completed", "interrupted", "failed")),
  failure: Schema.optional(Schema.String),
  series: SeriesSchema,
  run: RunSchema,
  versions: VersionsSchema,
  fileSync: Schema.Struct({
    eligible: Schema.Boolean,
    reason: Schema.String,
  }),
  fixtures: Schema.Array(FixtureSchema).pipe(Schema.maxItems(2)),
  lanes: Schema.Array(LaneSchema).pipe(Schema.maxItems(MAX_LANES)),
});

export const WorkflowPerformanceReportSchema = WorkflowPerformanceReportStruct.pipe(
  Schema.filter((report) =>
    report.lanes.every((lane) =>
      lane.samples.every((sample) =>
        isWorkflowPerformanceSampleKey(sample.key, report.run.id, lane.id, sample.index),
      ),
    )
      ? undefined
      : "sample keys must be derived from their lane and ordinal",
  ),
);

export type WorkflowPerformanceReport = typeof WorkflowPerformanceReportSchema.Type;
export type WorkflowPerformanceLaneReport = typeof LaneSchema.Type;
export type WorkflowPerformanceSample = typeof SampleSchema.Type;
export type WorkflowPerformanceStatistics = typeof StatisticsSchema.Type;

export const boundedPerformanceEvidence = (value: string): string =>
  value.length <= EVIDENCE_LIMIT ? value : `${value.slice(value.length - EVIDENCE_LIMIT)}\n[truncated]`;

const percentile = (sorted: readonly number[], fraction: number): number => {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
};

export const statisticsForSamples = (
  samples: readonly WorkflowPerformanceSample[],
): WorkflowPerformanceStatistics | undefined => {
  const durations = samples
    .filter((sample) => sample.outcome === "passed")
    .map((sample) => sample.steps.reduce((total, step) => total + step.durationMs, 0))
    .sort((left, right) => left - right);
  if (durations.length === 0) return undefined;
  return {
    successfulSamples: durations.length,
    minMs: durations[0] ?? 0,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1] ?? 0,
  };
};

export const decodeWorkflowPerformanceReport = (input: unknown): WorkflowPerformanceReport =>
  Schema.decodeUnknownSync(WorkflowPerformanceReportSchema)(input);

const sanitizeWorkflowPerformanceReportForRetention = (
  report: WorkflowPerformanceReport,
): WorkflowPerformanceReport => ({
  schemaVersion: report.schemaVersion,
  ...(report.status === undefined ? {} : { status: report.status }),
  series: report.series,
  run: report.run,
  versions: report.versions,
  fileSync: { eligible: report.fileSync.eligible, reason: OMITTED_DIAGNOSTIC },
  fixtures: report.fixtures,
  lanes: report.lanes.map((lane) => ({
    id: lane.id,
    class: lane.class,
    outcome: lane.outcome,
    samples: lane.samples.map((sample) => ({
      index: sample.index,
      key: workflowPerformanceSampleKey(lane.id, sample.index),
      outcome: sample.outcome,
      resetCondition: OMITTED_DIAGNOSTIC,
      ...(sample.stagedFixture === undefined
        ? {}
        : {
            stagedFixture: {
              path: OMITTED_DIAGNOSTIC,
              bytes: sample.stagedFixture.bytes,
              sha256: sample.stagedFixture.sha256,
            },
          }),
      steps: sample.steps.map((step) => ({
        id: step.id,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        stdout: "",
        stderr: step.stdout.length === 0 && step.stderr.length === 0 ? "" : OMITTED_DIAGNOSTIC,
        ...(step.diagnostic === undefined ? {} : { diagnostic: step.diagnostic }),
      })),
    })),
    ...(lane.statistics === undefined ? {} : { statistics: lane.statistics }),
  })),
});

export const evaluateWorkflowPerformanceReport = (
  report: WorkflowPerformanceReport,
): { readonly exitCode: 0 | 1; readonly reason: string } =>
  (report.status !== undefined && report.status !== "completed") ||
  report.lanes.some(
    (laneReport) =>
      laneReport.outcome === "failed" || laneReport.samples.some((sample) => sample.outcome === "failed"),
  )
    ? { exitCode: 1, reason: "workflow correctness or report plumbing failed" }
    : { exitCode: 0, reason: "all supported workflow samples passed" };

export const writeWorkflowPerformanceReport = async (
  report: WorkflowPerformanceReport,
  path: string,
): Promise<void> => {
  const decoded = decodeWorkflowPerformanceReport(sanitizeWorkflowPerformanceReportForRetention(report));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(decoded, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
};
