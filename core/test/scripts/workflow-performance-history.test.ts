import { describe, expect, test } from "bun:test";

import {
  buildWorkflowPerformanceHistory,
  renderWorkflowPerformanceHistoryMarkdown,
} from "../../../scripts/workflow-performance-history.ts";
import type { WorkflowPerformanceReport } from "../../../scripts/workflow-performance-report.ts";

const report = (
  fixtureSet = "db-v1",
  lanes: WorkflowPerformanceReport["lanes"] = [],
): WorkflowPerformanceReport => ({
  schemaVersion: 1,
  series: { provider: "lando", platform: "linux-x64", fixtureSet },
  run: {
    id: "current",
    attempt: 1,
    commit: "abc",
    generatedAt: "2026-09-11T00:00:00.000Z",
    architecture: "x64",
    runner: "ubuntu-24.04",
  },
  versions: { binary: "4", runtime: "6", provider: "4" },
  fileSync: { eligible: false, reason: "native" },
  fixtures: [],
  lanes,
});

const passingLane: WorkflowPerformanceReport["lanes"][number] = {
  id: "cold-first-start",
  class: "start",
  outcome: "passed",
  samples: [],
  statistics: { successfulSamples: 5, minMs: 10, medianMs: 20, p95Ms: 30, maxMs: 30 },
};

describe("workflow performance history", () => {
  test("keeps incompatible, expired, failed, partial, and missing runs visible", () => {
    const current = report("db-v1", [passingLane, { ...passingLane, id: "warm-stop-start" }]);
    const summary = buildWorkflowPerformanceHistory(
      current,
      [
        {
          runId: "available",
          createdAt: "2026-09-10T00:00:00.000Z",
          conclusion: "success",
          report: report("db-v1", [passingLane]),
        },
        {
          runId: "incompatible",
          createdAt: "2026-09-09T00:00:00.000Z",
          conclusion: "success",
          report: report("db-v2", [passingLane]),
        },
        {
          runId: "other-cell-failed",
          createdAt: "2026-09-08T12:00:00.000Z",
          conclusion: "failure",
          report: report("db-v1", [passingLane]),
        },
        { runId: "missing", createdAt: "2026-09-08T00:00:00.000Z", conclusion: "success" },
        { runId: "failed", createdAt: "2026-09-07T00:00:00.000Z", conclusion: "failure" },
        {
          runId: "expired",
          createdAt: "2026-01-01T00:00:00.000Z",
          conclusion: "success",
          report: report("db-v1", [passingLane]),
        },
      ],
      Date.parse("2026-09-11T00:00:00.000Z"),
    );

    expect(summary.rows.map((row) => row.status)).toEqual([
      "available",
      "incompatible",
      "available",
      "missing",
      "failed",
      "expired",
    ]);
    expect(summary.rows[0]?.medians).toEqual({ "cold-first-start": 20 });
    expect(summary.rows[2]?.medians).toEqual({ "cold-first-start": 20 });
    const markdown = renderWorkflowPerformanceHistoryMarkdown(summary);
    expect(markdown).toContain("| available | 2026-09-10T00:00:00.000Z | available | 20.0 ms | — |");
    expect(markdown).toContain("| missing | 2026-09-08T00:00:00.000Z | missing | — | — |");
  });

  test("limits history to the newest thirty runs", () => {
    const current = report("db-v1", [passingLane]);
    const candidates = Array.from({ length: 35 }, (_, index) => ({
      runId: String(index),
      createdAt: new Date(Date.parse("2026-09-11T00:00:00.000Z") - index * 1_000).toISOString(),
      conclusion: "success",
      report: current,
    }));
    const summary = buildWorkflowPerformanceHistory(current, candidates);
    expect(summary.rows).toHaveLength(30);
    expect(summary.rows[0]?.runId).toBe("0");
  });
});
