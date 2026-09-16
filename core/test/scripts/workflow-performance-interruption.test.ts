import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type WorkflowPerformanceCommand,
  runWorkflowPerformanceCommand,
} from "../../../scripts/workflow-performance-command.ts";
import {
  decodeWorkflowPerformanceReport,
  evaluateWorkflowPerformanceReport,
} from "../../../scripts/workflow-performance-report.ts";
import { runWorkflowPerformance } from "../../../scripts/workflow-performance-runner.ts";

test("persists each sample before the next preparation and retains prep failure duration", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "perf-incremental-"));
  try {
    const reportPath = join(rootDir, "report.json");
    let setups = 0;
    let partial: ReturnType<typeof decodeWorkflowPerformanceReport> | undefined;
    const report = await runWorkflowPerformance({
      binary: "/fake/lando",
      rootDir,
      report: reportPath,
      runId: "incremental",
      runAttempt: 1,
      commit: "abc",
      platform: "linux-x64",
      architecture: "x64",
      runner: "fake",
      binaryVersion: "test",
      runtimeVersion: "test",
      providerVersion: "test",
      fixtureSeed: "test",
      startSampleCount: 1,
      heavySampleCount: 1,
      runCommand: async (command) => {
        if (command.id === "prepare:setup" && setups++ === 1) {
          partial = decodeWorkflowPerformanceReport(await Bun.file(reportPath).json());
        }
        return {
          id: command.id,
          durationMs: 835_000,
          exitCode: command.id === "prepare:setup" ? 124 : 0,
          stdout: "",
          stderr: "timeout",
        };
      },
    });
    expect(setups).toBe(report.lanes.length);
    expect(partial?.lanes[0]?.samples[0]?.steps[0]?.durationMs).toBe(835_000);
    expect(partial?.status).toBe("running");
    const retained = decodeWorkflowPerformanceReport(await Bun.file(reportPath).json());
    expect(retained.status).toBe(report.status);
    expect(retained.lanes).toHaveLength(report.lanes.length);
    expect(retained.lanes[0]?.samples[0]?.steps[0]).toMatchObject({
      id: "prepare:setup",
      exitCode: 124,
      durationMs: 835_000,
      stdout: "",
      stderr: "[diagnostic evidence omitted]",
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("retains interrupted prep and attempts every owned cleanup with independent deadlines", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "perf-interruption-"));
  const reportPath = join(rootDir, "report.json");
  const controller = new AbortController();
  const commands: WorkflowPerformanceCommand[] = [];
  try {
    const report = await runWorkflowPerformance({
      binary: "/fake/lando",
      rootDir,
      report: reportPath,
      runId: "interrupted",
      runAttempt: 1,
      commit: "abc",
      platform: "linux-x64",
      architecture: "x64",
      runner: "fake-child",
      binaryVersion: "test",
      runtimeVersion: "test",
      providerVersion: "test",
      fixtureSeed: "test",
      startSampleCount: 1,
      heavySampleCount: 1,
      signal: controller.signal,
      sampleTimeoutMs: 100,
      runCommand: async (command) => {
        commands.push(command);
        if (command.id.startsWith("cleanup:")) {
          return {
            id: command.id,
            exitCode: command.id === "cleanup:global" ? 8 : 0,
            durationMs: 1,
            stdout: "",
            stderr: "cleanup evidence",
          };
        }
        const result = await runWorkflowPerformanceCommand({
          ...command,
          argv: [
            process.execPath,
            "-e",
            "process.stderr.write('waiting'); setTimeout(()=>process.exit(7),1500)",
          ],
        });
        controller.abort();
        return result;
      },
    });
    expect(report.status).toBe("interrupted");
    expect(report.lanes[0]?.samples[0]?.steps).toEqual([
      expect.objectContaining({
        id: "prepare:setup",
        exitCode: 124,
        stderr: "[diagnostic evidence omitted]",
      }),
      expect.objectContaining({ id: "cleanup:global", exitCode: 8 }),
    ]);
    expect(report.lanes[0]?.statistics).toBeUndefined();
    expect(evaluateWorkflowPerformanceReport(report).exitCode).toBe(1);
    const retained = decodeWorkflowPerformanceReport(await Bun.file(reportPath).json());
    expect(retained.status).toBe("interrupted");
    expect(retained.lanes[0]?.samples[0]?.steps).toEqual([
      expect.objectContaining({
        id: "prepare:setup",
        exitCode: 124,
        stdout: "",
        stderr: "[diagnostic evidence omitted]",
      }),
      expect.objectContaining({
        id: "cleanup:global",
        exitCode: 8,
        stdout: "",
        stderr: "[diagnostic evidence omitted]",
      }),
    ]);
    expect(commands.map((command) => command.id)).toEqual([
      "prepare:setup",
      "cleanup:destroy",
      "cleanup:global",
      "cleanup:runtime",
    ]);
    const root = commands[0]?.env.LANDO_USER_DATA_ROOT;
    expect(root).toBeTruthy();
    expect(Buffer.byteLength(join(root ?? "", "runtime/run/podman.sock"))).toBeLessThan(108);
    for (const command of commands) {
      if (command.id.startsWith("cleanup:")) {
        expect(command.signal).toBeUndefined();
        expect(command.timeoutMs).toBe(30_000);
      }
      expect(command.env.LANDO_USER_DATA_ROOT).toBe(root);
      expect(command.argv).not.toContain("poweroff");
      expect(command.argv).not.toContain("prune");
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("the production entry writes a failed report and exits nonzero on filesystem preparation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-entry-"));
  try {
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    const report = join(root, "report.json");
    const result = await runWorkflowPerformanceCommand({
      id: "entry",
      cwd: root,
      env: process.env,
      argv: [
        process.execPath,
        join(import.meta.dir, "../../../scripts/workflow-performance.ts"),
        "--binary",
        "/never-executed/lando",
        "--root-dir",
        blocked,
        "--report",
        report,
        "--run-id",
        "failure",
        "--commit",
        "abc",
        "--platform",
        "linux-x64",
        "--architecture",
        "x64",
        "--runner",
        "fake",
        "--binary-version",
        "test",
        "--runtime-version",
        "test",
        "--provider-version",
        "test",
        "--fixture-seed",
        "test",
      ],
    });
    expect(result.exitCode).toBe(1);
    const decoded = decodeWorkflowPerformanceReport(await Bun.file(report).json());
    expect(decoded.status).toBe("failed");
    expect(decoded.lanes).toEqual([]);
    expect(evaluateWorkflowPerformanceReport(decoded).exitCode).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
