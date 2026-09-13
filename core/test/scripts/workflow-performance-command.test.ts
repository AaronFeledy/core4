import { describe, expect, test } from "bun:test";

import { runWorkflowPerformanceCommand } from "../../../scripts/workflow-performance-command.ts";

describe("workflow performance command runner", () => {
  test("kills and reaps a stalled child while retaining its failure evidence", async () => {
    // Given a real child that ignores graceful termination and emits evidence.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    // When its command deadline expires (the external abort bounds the red test).
    const result = await runWorkflowPerformanceCommand({
      id: "stalled",
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
      id: "controlled-failure",
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
      id: "bounded",
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(13000))"],
      cwd: import.meta.dir,
      env: process.env,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.endsWith("\n[truncated]")).toBe(true);
  });
});
