import { describe, expect, test } from "bun:test";

import {
  DEFAULT_WORKFLOW_PERFORMANCE_SAMPLE_TIMEOUT_MS,
  runWorkflowPerformanceCommand,
  timeoutMsForPerformanceCommand,
  workflowPerformanceDeadlineRunner,
} from "../../../scripts/workflow-performance-command.ts";

describe("workflow performance command runner", () => {
  test("kills and reaps a stalled child while retaining its failure evidence", async () => {
    // Given a real child that ignores graceful termination and emits evidence.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    // When its command deadline expires (the external abort bounds the red test).
    const result = await runWorkflowPerformanceCommand({
      id: "prepare:start",
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)); process.stderr.write('stalled'); setTimeout(()=>process.exit(7),1500)",
      ],
      cwd: import.meta.dir,
      env: process.env,
      timeoutMs: 50,
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Then this is a timeout, not a fast successful sample.
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("stalled");
    expect(result.durationMs).toBeGreaterThanOrEqual(50);
    expect(result.durationMs).toBeLessThan(1000);
    expect(() => process.kill(Number(result.stdout), 0)).toThrow();
  });
  test("records duration and preserves a nonzero correctness failure", async () => {
    const result = await runWorkflowPerformanceCommand({
      id: "prepare:failure",
      argv: [process.execPath, "-e", "process.stderr.write('fixture rejected'); process.exit(7)"],
      cwd: import.meta.dir,
      env: process.env,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("fixture rejected");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("bounds subprocess evidence", async () => {
    const result = await runWorkflowPerformanceCommand({
      id: "info",
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(13000))"],
      cwd: import.meta.dir,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith("\n[truncated]")).toBe(true);
  });

  test("captures a closed image-pull diagnostic before raw stderr is omitted", async () => {
    // Given a child emits one private closed failure-evidence payload and unrelated raw text.
    const evidence = JSON.stringify({
      causes: [],
      imagePull: {
        domain: "image-pull",
        failureKind: "registry-auth",
        httpStatus: 401,
        transportKind: "http",
      },
    });

    // When the real command runner captures the child.
    const result = await runWorkflowPerformanceCommand({
      id: "prepare:setup",
      argv: [
        process.execPath,
        "-e",
        `process.stderr.write(${JSON.stringify(`failure-cause-evidence ${evidence}\nraw secret text`)})`,
      ],
      cwd: import.meta.dir,
      env: process.env,
    });

    // Then only the closed diagnosis is projected into the structured result.
    expect(JSON.stringify(result)).toContain(
      '"diagnostic":{"domain":"image-pull","failureKind":"registry-auth","httpStatus":401,"transportKind":"http"}',
    );
  });

  test("assigns bounded phase-specific budgets that fit the 360-minute job", () => {
    expect(timeoutMsForPerformanceCommand("prepare:setup")).toBe(180_000);
    expect(timeoutMsForPerformanceCommand("prepare:pre-pull")).toBe(180_000);
    expect(timeoutMsForPerformanceCommand("prepare:start")).toBe(180_000);
    expect(timeoutMsForPerformanceCommand("start")).toBe(180_000);
    expect(timeoutMsForPerformanceCommand("rebuild")).toBe(180_000);
    expect(timeoutMsForPerformanceCommand("db:import")).toBe(120_000);
    expect(timeoutMsForPerformanceCommand("prepare:import")).toBe(120_000);
    expect(timeoutMsForPerformanceCommand("prepare:snapshot")).toBe(120_000);
    expect(DEFAULT_WORKFLOW_PERFORMANCE_SAMPLE_TIMEOUT_MS).toBe(900_000);
    expect(DEFAULT_WORKFLOW_PERFORMANCE_SAMPLE_TIMEOUT_MS).toBeLessThan(360 * 60_000);
  });

  test("deadline runner uses the phase budget unless a command timeout is set", async () => {
    const seen: number[] = [];
    const run = workflowPerformanceDeadlineRunner({
      sampleTimeoutMs: 600_000,
      runCommand: async (command) => {
        seen.push(command.timeoutMs ?? 0);
        return { id: command.id, durationMs: 1, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    await run({
      id: "prepare:setup",
      argv: [process.execPath, "-e", ""],
      cwd: import.meta.dir,
      env: process.env,
    });
    await run({
      id: "db:import",
      argv: [process.execPath, "-e", ""],
      cwd: import.meta.dir,
      env: process.env,
    });
    expect(seen[0]).toBe(180_000);
    expect(seen[1]).toBe(120_000);
  });
});
