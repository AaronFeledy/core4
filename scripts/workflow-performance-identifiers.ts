export const WORKFLOW_PERFORMANCE_LANE_IDS = [
  "cold-first-start",
  "warm-stop-start",
  "unchanged-rebuild",
  "mysql-import",
  "mysql-snapshot-restore",
  "postgres-import",
  "postgres-snapshot-restore",
  "drupal-journey",
  "rails-journey",
] as const;

export const WORKFLOW_PERFORMANCE_STEP_IDS = [
  "entry",
  "prepare:setup",
  "prepare:pre-pull",
  "prepare:start",
  "prepare:import",
  "prepare:snapshot",
  "prepare:failure",
  "start",
  "stop",
  "rebuild",
  "db:import",
  "db:restore",
  "init",
  "info",
  "scaffold",
  "composer-json",
  "drush-bin",
  "drush-version",
  "destroy",
  "rails",
  "bundle",
  "validate:journey",
  "cleanup:ownership",
  "cleanup:destroy",
  "cleanup:global",
  "cleanup:runtime",
  "cleanup:storage",
  "cleanup:storage-helpers",
] as const;

export type WorkflowPerformanceLaneId = (typeof WORKFLOW_PERFORMANCE_LANE_IDS)[number];
export type WorkflowPerformanceStepId = (typeof WORKFLOW_PERFORMANCE_STEP_IDS)[number];

export const workflowPerformanceSampleKey = (
  laneId: WorkflowPerformanceLaneId,
  sampleIndex: number,
): string => `perf-${laneId}-${String(sampleIndex + 1)}`;

export const legacyWorkflowPerformanceSampleKey = (
  runId: string,
  laneId: WorkflowPerformanceLaneId,
  sampleIndex: number,
): string => {
  const normalizedRunId = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  const runKey = normalizedRunId.length === 0 ? "run" : normalizedRunId;
  return `perf-${runKey}-${laneId}-${String(sampleIndex + 1)}`;
};

export const isWorkflowPerformanceSampleKey = (
  key: string,
  runId: string,
  laneId: WorkflowPerformanceLaneId,
  sampleIndex: number,
): boolean =>
  key === workflowPerformanceSampleKey(laneId, sampleIndex) ||
  key === legacyWorkflowPerformanceSampleKey(runId, laneId, sampleIndex);
