import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { WorkflowPerformanceCommand } from "../../../scripts/workflow-performance-command.ts";
import { evaluateWorkflowPerformanceReport } from "../../../scripts/workflow-performance-report.ts";
import { runWorkflowPerformance } from "../../../scripts/workflow-performance-runner.ts";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "workflow-performance-runner-"));
});

afterEach(async () => {
  await rm(rootDir, { force: true, recursive: true });
});

const options = () => ({
  binary: "/fake/lando",
  rootDir,
  runId: "run-42",
  runAttempt: 1,
  commit: "abc123",
  platform: "linux-x64",
  architecture: "x64",
  runner: "ubuntu-24.04",
  binaryVersion: "4.0.0",
  runtimeVersion: "6.0.0",
  providerVersion: "4.0.0",
  fixtureSeed: "fixture-v1",
  startSampleCount: 1,
  heavySampleCount: 1,
});

describe("workflow performance runner", () => {
  test("uses independent roots, pre-pulls images, and records journey step timings", async () => {
    const commands: WorkflowPerformanceCommand[] = [];
    const report = await runWorkflowPerformance({
      ...options(),
      runCommand: (command) => {
        commands.push(command);
        const appName = command.argv.at(-2);
        const initTargetExists =
          command.id === "init" && appName !== undefined && existsSync(join(command.cwd, appName));
        return Promise.resolve({
          id: command.id,
          durationMs: 12,
          exitCode: initTargetExists ? 1 : 0,
          stdout:
            command.id === "prepare:setup"
              ? "file-sync: already satisfied (native bind mounts)"
              : "http://app.test",
          stderr: initTargetExists ? "init destination already exists" : "",
        });
      },
    });

    const setupRoots = commands
      .filter((command) => command.id === "prepare:setup")
      .map((command) => command.env.LANDO_USER_DATA_ROOT);
    const xdgRoots = commands
      .filter((command) => command.id === "prepare:setup")
      .map((command) => command.env.XDG_RUNTIME_DIR);
    expect(new Set(setupRoots).size).toBe(report.lanes.length);
    expect(new Set(xdgRoots).size).toBe(report.lanes.length);
    expect(commands.filter((command) => command.id === "prepare:pre-pull").length).toBeGreaterThan(
      report.lanes.length,
    );
    expect(report.fileSync).toEqual({
      eligible: true,
      reason: "Provider readiness reported native bind mounts.",
    });
    expect(
      report.lanes.find((lane) => lane.id === "drupal-journey")?.samples[0]?.steps.map((step) => step.id),
    ).toEqual([
      "init",
      "start",
      "info",
      "scaffold",
      "composer-json",
      "drush-bin",
      "drush-version",
      "destroy",
    ]);
    const firstSample = report.lanes[0]?.samples[0];
    if (firstSample === undefined) throw new Error("expected a cold-start sample");
    expect(
      await Bun.file(join(rootDir, "samples", firstSample.key, "apps", firstSample.key, ".lando.yml")).text(),
    ).toContain(`name: ${firstSample.key}`);
    expect(evaluateWorkflowPerformanceReport(report).exitCode).toBe(0);
  });

  test("retains a controlled failing fixture and exits nonzero", async () => {
    const report = await runWorkflowPerformance({
      ...options(),
      failingFixtureLane: "mysql-import",
      runCommand: (command) => {
        const controlledFailure =
          command.id === "db:import" && command.argv.some((arg) => arg.endsWith("controlled-failure.sql"));
        return Promise.resolve({
          id: command.id,
          durationMs: 1,
          exitCode: controlledFailure ? 9 : 0,
          stdout: command.id === "prepare:setup" ? "file-sync: unavailable" : "http://app.test",
          stderr: controlledFailure ? "invalid SQL fixture" : "",
        });
      },
    });

    const mysqlImport = report.lanes.find((lane) => lane.id === "mysql-import");
    expect(mysqlImport?.outcome).toBe("failed");
    expect(mysqlImport?.samples[0]?.steps[0]).toMatchObject({ exitCode: 9, stderr: "invalid SQL fixture" });
    expect(mysqlImport?.statistics).toBeUndefined();
    expect(evaluateWorkflowPerformanceReport(report).exitCode).toBe(1);
  });

  test("fails journey samples when their existing semantic checks fail", async () => {
    const report = await runWorkflowPerformance({
      ...options(),
      runCommand: (command) =>
        Promise.resolve({
          id: command.id,
          durationMs: 1,
          exitCode: 0,
          stdout: command.id === "prepare:setup" ? "file-sync: unavailable" : "completed without a route",
          stderr: "",
        }),
    });

    for (const laneId of ["drupal-journey", "rails-journey"] as const) {
      const lane = report.lanes.find((candidate) => candidate.id === laneId);
      expect(lane?.outcome).toBe("failed");
      expect(lane?.samples[0]?.steps.at(-1)).toMatchObject({
        id: "validate:journey",
        exitCode: 1,
      });
    }
    expect(evaluateWorkflowPerformanceReport(report).exitCode).toBe(1);
  });
});
