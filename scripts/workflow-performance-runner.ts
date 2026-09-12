import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";
import { runWorkflowPerformanceCommand } from "./workflow-performance-command.ts";
import { generateDatabaseFixture } from "./workflow-performance-fixtures.ts";
import {
  type WorkflowPerformanceLanePlan,
  buildWorkflowPerformancePlan,
  workflowPerformanceSampleKey,
} from "./workflow-performance-plan.ts";
import type {
  WorkflowPerformanceLaneReport,
  WorkflowPerformanceReport,
  WorkflowPerformanceSample,
} from "./workflow-performance-report.ts";
import { statisticsForSamples } from "./workflow-performance-report.ts";
import { runWorkflowPerformanceSample } from "./workflow-performance-sample.ts";

export type RunWorkflowPerformanceOptions = {
  readonly binary: string;
  readonly rootDir: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly commit: string;
  readonly platform: string;
  readonly architecture: string;
  readonly runner: string;
  readonly binaryVersion: string;
  readonly runtimeVersion: string;
  readonly providerVersion: string;
  readonly fixtureSeed: string;
  readonly startSampleCount?: number;
  readonly heavySampleCount?: number;
  readonly failingFixtureLane?: "mysql-import" | "postgres-import";
  readonly runCommand?: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>;
};

const laneReport = (
  lane: WorkflowPerformanceLanePlan,
  samples: readonly WorkflowPerformanceSample[],
): WorkflowPerformanceLaneReport => {
  const outcome = samples.some((sample) => sample.outcome === "failed") ? "failed" : "passed";
  const statistics = statisticsForSamples(samples);
  return {
    id: lane.id,
    class: lane.class,
    outcome,
    samples,
    ...(statistics === undefined ? {} : { statistics }),
  };
};

export const runWorkflowPerformance = async (
  options: RunWorkflowPerformanceOptions,
): Promise<WorkflowPerformanceReport> => {
  const runCommand = options.runCommand ?? runWorkflowPerformanceCommand;
  const plan = buildWorkflowPerformancePlan(options);
  await mkdir(options.rootDir, { recursive: true });
  const mysql = generateDatabaseFixture({ family: "mysql", seed: options.fixtureSeed });
  const postgres = generateDatabaseFixture({ family: "postgres", seed: options.fixtureSeed });
  const fixtureDir = join(options.rootDir, "fixtures");
  await mkdir(fixtureDir, { recursive: true });
  const fixturePaths = {
    mysql: join(fixtureDir, "mysql.sql"),
    postgres: join(fixtureDir, "postgres.sql"),
  } as const;
  await Promise.all([
    writeFile(fixturePaths.mysql, mysql.contents),
    writeFile(fixturePaths.postgres, postgres.contents),
  ]);
  const invalidFixturePath = join(fixtureDir, "controlled-failure.sql");
  await writeFile(invalidFixturePath, "THIS IS A CONTROLLED INVALID SQL FIXTURE;\n");
  const lanes: WorkflowPerformanceLaneReport[] = [];
  const fileSyncEvidence: string[] = [];
  for (const lane of plan.lanes) {
    const samples: WorkflowPerformanceSample[] = [];
    for (let index = 0; index < lane.sampleCount; index += 1) {
      const key = workflowPerformanceSampleKey(options.runId, lane.id, index);
      const fixturePath =
        lane.fixtureFamily === undefined
          ? undefined
          : options.failingFixtureLane === lane.id
            ? invalidFixturePath
            : fixturePaths[lane.fixtureFamily];
      const result = await runWorkflowPerformanceSample({
        lane,
        binary: options.binary,
        rootDir: options.rootDir,
        index,
        key,
        ...(fixturePath === undefined ? {} : { fixturePath }),
        runCommand,
      });
      samples.push(result.sample);
      fileSyncEvidence.push(result.fileSyncEvidence);
    }
    lanes.push(laneReport(lane, samples));
  }
  const nativeFileSync = fileSyncEvidence.some((evidence) =>
    evidence.includes("already satisfied (native bind mounts)"),
  );
  return {
    schemaVersion: 1,
    series: {
      provider: "lando",
      platform: options.platform,
      fixtureSet: `database-v1-${mysql.sha256.slice(0, 12)}-${postgres.sha256.slice(0, 12)}`,
    },
    run: {
      id: options.runId,
      attempt: options.runAttempt,
      commit: options.commit,
      generatedAt: new Date().toISOString(),
      architecture: options.architecture,
      runner: options.runner,
    },
    versions: {
      binary: options.binaryVersion,
      runtime: options.runtimeVersion,
      provider: options.providerVersion,
    },
    fileSync: {
      eligible: nativeFileSync,
      reason: nativeFileSync
        ? "Provider readiness reported native bind mounts."
        : "Provider setup did not report a ready file-sync path; no sync measurement was recorded.",
    },
    fixtures: [mysql, postgres].map(({ contents: _contents, ...identity }) => identity),
    lanes,
  };
};
