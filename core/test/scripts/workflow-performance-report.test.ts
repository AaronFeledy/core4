import { describe, expect, test } from "bun:test";

import {
  type WorkflowPerformanceReport,
  type WorkflowPerformanceSample,
  boundedPerformanceEvidence,
  decodeWorkflowPerformanceReport,
  evaluateWorkflowPerformanceReport,
  statisticsForSamples,
} from "../../../scripts/workflow-performance-report.ts";

const sample = (
  index: number,
  outcome: "passed" | "failed",
  durationMs: number,
): WorkflowPerformanceSample => ({
  index,
  key: `sample-${String(index)}`,
  outcome,
  resetCondition: "fresh roots and owned app identity",
  steps: [{ id: "start", durationMs, exitCode: outcome === "passed" ? 0 : 7, stdout: "", stderr: "" }],
});

const report = (samples: readonly WorkflowPerformanceSample[]): WorkflowPerformanceReport => ({
  schemaVersion: 1,
  series: { provider: "lando", platform: "linux-x64", fixtureSet: "db-v1" },
  run: {
    id: "42",
    attempt: 1,
    commit: "abc123",
    generatedAt: "2026-09-11T00:00:00.000Z",
    architecture: "x64",
    runner: "ubuntu-24.04",
  },
  versions: { binary: "4.0.0", runtime: "6.0.0", provider: "4.0.0" },
  fileSync: { eligible: false, reason: "native bind mounts" },
  fixtures: [],
  lanes: [
    {
      id: "cold-first-start",
      class: "start",
      outcome: samples.some((entry) => entry.outcome === "failed") ? "failed" : "passed",
      samples,
      statistics: statisticsForSamples(samples),
    },
  ],
});

describe("workflow performance report", () => {
  test("excludes failed samples from statistics and keeps timing advisory", () => {
    const samples = [sample(0, "passed", 10), sample(1, "failed", 1), sample(2, "passed", 30)];
    expect(statisticsForSamples(samples)).toEqual({
      successfulSamples: 2,
      minMs: 10,
      medianMs: 10,
      p95Ms: 30,
      maxMs: 30,
    });
    expect(evaluateWorkflowPerformanceReport(report(samples))).toEqual({
      exitCode: 1,
      reason: "workflow correctness or report plumbing failed",
    });
    expect(evaluateWorkflowPerformanceReport(report([sample(0, "passed", 90_000)])).exitCode).toBe(0);
  });

  test("bounds error evidence and validates reports through Effect Schema", () => {
    const bounded = boundedPerformanceEvidence("x".repeat(13_000));
    expect(bounded.endsWith("\n[truncated]")).toBe(true);
    expect(bounded.length).toBeLessThanOrEqual(12_012);
    expect(decodeWorkflowPerformanceReport(report([sample(0, "passed", 10)]))).toMatchObject({
      schemaVersion: 1,
    });
    expect(() => decodeWorkflowPerformanceReport({ ...report([]), schemaVersion: 2 })).toThrow();
  });
});
