import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileSyncStatus } from "../core/src/cli/command-specs/meta/setup-inputs.ts";
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
import {
  boundedPerformanceEvidence,
  statisticsForSamples,
  writeWorkflowPerformanceReport,
} from "./workflow-performance-report.ts";
import { runWorkflowPerformanceSample } from "./workflow-performance-sample.ts";

export type RunWorkflowPerformanceOptions = {
  readonly binary: string;
  readonly report?: string;
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  readonly sampleTimeoutMs?: number;
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
  skipReason?: string,
): WorkflowPerformanceLaneReport => {
  const outcome = samples.some((sample) => sample.outcome === "failed") ? "failed" : "passed";
  if (outcome === "passed" && skipReason !== undefined) {
    return { id: lane.id, class: lane.class, outcome: "skipped", samples: [], skipReason };
  }
  const statistics = statisticsForSamples(samples);
  return {
    id: lane.id,
    class: lane.class,
    outcome,
    samples,
    ...(statistics === undefined ? {} : { statistics }),
    ...(skipReason === undefined ? {} : { skipReason }),
  };
};

export const runWorkflowPerformance = async (
  options: RunWorkflowPerformanceOptions,
): Promise<WorkflowPerformanceReport> => {
  const runCommand = options.runCommand ?? runWorkflowPerformanceCommand;
  const plan = buildWorkflowPerformancePlan(options);
  const mysql = generateDatabaseFixture({ family: "mysql", seed: options.fixtureSeed });
  const postgres = generateDatabaseFixture({ family: "postgres", seed: options.fixtureSeed });
  const lanes: WorkflowPerformanceLaneReport[] = [];
  const fileSyncStatuses: FileSyncStatus[] = [];
  let status: NonNullable<WorkflowPerformanceReport["status"]> = "running";
  let failure: string | undefined;
  const snapshot = (): WorkflowPerformanceReport => {
    const nativeFileSync = fileSyncStatuses.includes("satisfied");
    return {
      schemaVersion: 1,
      status,
      ...(failure === undefined ? {} : { failure }),
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
      lanes: [...lanes],
    };
  };
  const persist = async () => {
    const report = snapshot();
    if (options.report !== undefined) await writeWorkflowPerformanceReport(report, options.report);
    return report;
  };
  await persist();
  try {
    await mkdir(options.rootDir, { recursive: true });
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
    for (const lane of plan.lanes) {
      const samples: WorkflowPerformanceSample[] = [];
      let skipReason: string | undefined;
      const laneIndex = lanes.length;
      for (let index = 0; index < lane.sampleCount; index += 1) {
        if (options.signal?.aborted) {
          status = "interrupted";
          return await persist();
        }
        const key = workflowPerformanceSampleKey(lane.id, index);
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
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
          ...(options.sampleTimeoutMs === undefined ? {} : { sampleTimeoutMs: options.sampleTimeoutMs }),
        });
        if (result.fileSyncStatus !== undefined) fileSyncStatuses.push(result.fileSyncStatus);
        if ("skipReason" in result) {
          skipReason = result.skipReason;
          lanes[laneIndex] = laneReport(lane, samples, skipReason);
          await persist();
          break;
        }
        samples.push(result.sample);
        lanes[laneIndex] = laneReport(lane, samples);
        await persist();
        if (result.sample.steps.some((step) => step.id.startsWith("cleanup:") && step.exitCode !== 0)) {
          status = options.signal?.aborted ? "interrupted" : "failed";
          failure = "Sample cleanup failed; stopped before acquiring further resources.";
          return await persist();
        }
      }
      lanes[laneIndex] = laneReport(lane, samples, skipReason);
    }
    status = options.signal?.aborted ? "interrupted" : "completed";
  } catch (cause) {
    status = options.signal?.aborted ? "interrupted" : "failed";
    failure = boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause));
  }
  return persist();
};
