import { Either, Schema } from "effect";

import {
  type WorkflowPerformanceReport,
  WorkflowPerformanceReportSchema,
} from "./workflow-performance-report.ts";

export type WorkflowPerformanceHistoryCandidate = {
  readonly runId: string;
  readonly createdAt: string;
  readonly conclusion: string;
  readonly report?: unknown;
};

export type WorkflowPerformanceHistoryStatus =
  | "available"
  | "expired"
  | "failed"
  | "incompatible"
  | "missing";

export type WorkflowPerformanceHistoryRow = {
  readonly runId: string;
  readonly createdAt: string;
  readonly status: WorkflowPerformanceHistoryStatus;
  readonly medians: Readonly<Record<string, number>>;
};

export type WorkflowPerformanceHistorySummary = {
  readonly schemaVersion: 1;
  readonly series: WorkflowPerformanceReport["series"];
  readonly lanes: readonly string[];
  readonly rows: readonly WorkflowPerformanceHistoryRow[];
};

const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const HISTORY_LIMIT = 30;

const sameSeries = (
  left: WorkflowPerformanceReport["series"],
  right: WorkflowPerformanceReport["series"],
): boolean =>
  left.provider === right.provider &&
  left.platform === right.platform &&
  left.fixtureSet === right.fixtureSet;

const mediansFor = (report: WorkflowPerformanceReport): Readonly<Record<string, number>> =>
  Object.fromEntries(
    report.lanes.flatMap((lane) =>
      lane.statistics === undefined ? [] : [[lane.id, lane.statistics.medianMs] as const],
    ),
  );

const rowFor = (
  current: WorkflowPerformanceReport,
  candidate: WorkflowPerformanceHistoryCandidate,
  now: number,
): WorkflowPerformanceHistoryRow => {
  const created = Date.parse(candidate.createdAt);
  if (!Number.isFinite(created) || now - created > RETENTION_MS) {
    return { runId: candidate.runId, createdAt: candidate.createdAt, status: "expired", medians: {} };
  }
  if (candidate.report === undefined) {
    const status = candidate.conclusion === "success" ? "missing" : "failed";
    return { runId: candidate.runId, createdAt: candidate.createdAt, status, medians: {} };
  }
  const decoded = Schema.decodeUnknownEither(WorkflowPerformanceReportSchema)(candidate.report);
  if (Either.isLeft(decoded) || !sameSeries(current.series, decoded.right.series)) {
    return { runId: candidate.runId, createdAt: candidate.createdAt, status: "incompatible", medians: {} };
  }
  return {
    runId: candidate.runId,
    createdAt: candidate.createdAt,
    status: decoded.right.lanes.some((lane) => lane.outcome === "failed") ? "failed" : "available",
    medians: mediansFor(decoded.right),
  };
};

export const buildWorkflowPerformanceHistory = (
  current: WorkflowPerformanceReport,
  candidates: readonly WorkflowPerformanceHistoryCandidate[],
  now: number = Date.now(),
): WorkflowPerformanceHistorySummary => {
  const rows = [...candidates]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, HISTORY_LIMIT)
    .map((candidate) => rowFor(current, candidate, now));
  return {
    schemaVersion: 1,
    series: current.series,
    lanes: current.lanes.map((lane) => lane.id),
    rows,
  };
};

const cell = (row: WorkflowPerformanceHistoryRow, lane: string): string => {
  const duration = row.medians[lane];
  return duration === undefined ? "—" : `${duration.toFixed(1)} ms`;
};

export const renderWorkflowPerformanceHistoryMarkdown = (
  summary: WorkflowPerformanceHistorySummary,
): string => {
  const header = ["Run", "Created", "Status", ...summary.lanes];
  const divider = header.map(() => "---");
  const rows = summary.rows.map((row) => [
    row.runId,
    row.createdAt,
    row.status,
    ...summary.lanes.map((lane) => cell(row, lane)),
  ]);
  return [
    `## Workflow performance: ${summary.series.provider} / ${summary.series.platform}`,
    "",
    `Fixture series: \`${summary.series.fixtureSet}\``,
    "",
    `| ${header.join(" | ")} |`,
    `| ${divider.join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
};
