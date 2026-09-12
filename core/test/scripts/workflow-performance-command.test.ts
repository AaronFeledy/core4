import { describe, expect, test } from "bun:test";

import { runWorkflowPerformanceCommand } from "../../../scripts/workflow-performance-command.ts";

describe("workflow performance command runner", () => {
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
