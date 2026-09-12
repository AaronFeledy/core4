import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HEAVY_SAMPLE_COUNT,
  DEFAULT_START_SAMPLE_COUNT,
  WORKFLOW_PERFORMANCE_CELLS,
  WORKFLOW_PERFORMANCE_LANE_IDS,
  buildWorkflowPerformancePlan,
  workflowPerformanceSampleKey,
} from "../../../scripts/workflow-performance-plan.ts";

describe("workflow performance plan", () => {
  test("derives jobs from GitHub-hosted Linux current-commit managed-runtime cells", () => {
    expect(WORKFLOW_PERFORMANCE_CELLS.map((cell) => cell.id)).toEqual(["linux-x64", "linux-arm64"]);
    expect(WORKFLOW_PERFORMANCE_CELLS.every((cell) => typeof cell.runsOn === "string")).toBe(true);
  });

  test("orders all required lanes with five start and three heavy samples", () => {
    const plan = buildWorkflowPerformancePlan({ runId: "run-42" });
    expect(plan.lanes.map((lane) => lane.id)).toEqual([...WORKFLOW_PERFORMANCE_LANE_IDS]);
    expect(
      plan.lanes
        .filter((lane) => lane.class === "start")
        .every((lane) => lane.sampleCount === DEFAULT_START_SAMPLE_COUNT),
    ).toBe(true);
    expect(
      plan.lanes
        .filter((lane) => lane.class === "heavy")
        .every((lane) => lane.sampleCount === DEFAULT_HEAVY_SAMPLE_COUNT),
    ).toBe(true);
  });

  test("keeps preparation outside measured steps and gives every sample an owned identity", () => {
    const plan = buildWorkflowPerformancePlan({ runId: "run-42", startSampleCount: 2, heavySampleCount: 1 });
    for (const lane of plan.lanes) {
      expect(lane.preparation.length).toBeGreaterThan(0);
      expect(lane.measuredSteps.length).toBeGreaterThan(0);
      expect(lane.preparation.some((step) => lane.measuredSteps.includes(step))).toBe(false);
    }
    expect(workflowPerformanceSampleKey("run-42", "cold-first-start", 0)).toBe(
      "perf-run-42-cold-first-start-1",
    );
    expect(workflowPerformanceSampleKey("run-42", "cold-first-start", 1)).not.toBe(
      workflowPerformanceSampleKey("run-42", "cold-first-start", 0),
    );
    expect(workflowPerformanceSampleKey("12345.linux-x64", "drupal-journey", 0)).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});
