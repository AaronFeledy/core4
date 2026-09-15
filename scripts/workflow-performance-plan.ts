import { PLATFORM_READINESS_CELLS, type PlatformReadinessCell } from "./ci-platforms.ts";

export const DEFAULT_START_SAMPLE_COUNT = 5;
export const DEFAULT_HEAVY_SAMPLE_COUNT = 3;

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

export type WorkflowPerformanceLaneId = (typeof WORKFLOW_PERFORMANCE_LANE_IDS)[number];
export type WorkflowPerformanceLaneClass = "start" | "heavy";
export type WorkflowPerformanceFixtureFamily = "mysql" | "postgres";

export type WorkflowPerformanceLanePlan = {
  readonly id: WorkflowPerformanceLaneId;
  readonly class: WorkflowPerformanceLaneClass;
  readonly sampleCount: number;
  readonly preparation: readonly string[];
  readonly measuredSteps: readonly string[];
  readonly fixtureFamily?: WorkflowPerformanceFixtureFamily;
  readonly requiresNativeBindMounts?: boolean;
};

export type WorkflowPerformancePlan = {
  readonly runId: string;
  readonly lanes: readonly WorkflowPerformanceLanePlan[];
};

export type BuildWorkflowPerformancePlanOptions = {
  readonly runId: string;
  readonly startSampleCount?: number;
  readonly heavySampleCount?: number;
};

export const isWorkflowPerformanceCell = (cell: PlatformReadinessCell): boolean =>
  cell.id.startsWith("linux-") &&
  cell.provider === "lando" &&
  cell.bundleMode === "current-commit" &&
  typeof cell.runsOn === "string" &&
  cell.runsOn.startsWith("ubuntu-");

export const WORKFLOW_PERFORMANCE_CELLS: readonly PlatformReadinessCell[] =
  PLATFORM_READINESS_CELLS.filter(isWorkflowPerformanceCell);

const lane = (
  id: WorkflowPerformanceLaneId,
  laneClass: WorkflowPerformanceLaneClass,
  sampleCount: number,
  preparation: readonly string[],
  measuredSteps: readonly string[],
  fixtureFamily?: WorkflowPerformanceFixtureFamily,
): WorkflowPerformanceLanePlan => ({
  id,
  class: laneClass,
  sampleCount,
  preparation,
  measuredSteps,
  ...(id === "drupal-journey" || id === "rails-journey" ? { requiresNativeBindMounts: true } : {}),
  ...(fixtureFamily === undefined ? {} : { fixtureFamily }),
});

export const buildWorkflowPerformancePlan = (
  options: BuildWorkflowPerformancePlanOptions,
): WorkflowPerformancePlan => {
  const startSamples = options.startSampleCount ?? DEFAULT_START_SAMPLE_COUNT;
  const heavySamples = options.heavySampleCount ?? DEFAULT_HEAVY_SAMPLE_COUNT;
  return {
    runId: options.runId,
    lanes: [
      lane("cold-first-start", "start", startSamples, ["setup", "init", "pre-pull"], ["start"]),
      lane(
        "warm-stop-start",
        "start",
        startSamples,
        ["setup", "init", "pre-pull", "prepare-running-app"],
        ["stop", "start"],
      ),
      lane(
        "unchanged-rebuild",
        "start",
        startSamples,
        ["setup", "init", "pre-pull", "prepare-running-app"],
        ["rebuild"],
      ),
      lane(
        "mysql-import",
        "heavy",
        heavySamples,
        ["setup", "init", "pre-pull", "prepare-running-database"],
        ["db:import"],
        "mysql",
      ),
      lane(
        "mysql-snapshot-restore",
        "heavy",
        heavySamples,
        ["setup", "init", "pre-pull", "prepare-running-database", "prepare-import", "prepare-snapshot"],
        ["db:restore"],
        "mysql",
      ),
      lane(
        "postgres-import",
        "heavy",
        heavySamples,
        ["setup", "init", "pre-pull", "prepare-running-database"],
        ["db:import"],
        "postgres",
      ),
      lane(
        "postgres-snapshot-restore",
        "heavy",
        heavySamples,
        ["setup", "init", "pre-pull", "prepare-running-database", "prepare-import", "prepare-snapshot"],
        ["db:restore"],
        "postgres",
      ),
      lane("drupal-journey", "heavy", heavySamples, ["setup", "pre-pull"], ["journey:drupal"]),
      lane("rails-journey", "heavy", heavySamples, ["setup", "pre-pull"], ["journey:rails"]),
    ],
  };
};

export const workflowPerformanceSampleKey = (
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
