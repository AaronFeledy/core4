import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowPerformanceCommand } from "../../../scripts/workflow-performance-command.ts";
import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test("restores Lando dispatch when the performance runner uses embedded Bun", async () => {
  // Given the environment inherited from meta:bun.
  const rootDir = await mkdtemp(join(tmpdir(), "perf-bun-"));
  const priorBun = process.env.BUN_BE_BUN;
  const priorReentry = process.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY;
  process.env.BUN_BE_BUN = "1";
  process.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY = "1";
  const commands: WorkflowPerformanceCommand[] = [];
  try {
    const lane = buildWorkflowPerformancePlan({ runId: "bun", startSampleCount: 1, heavySampleCount: 1 })
      .lanes[0];
    if (lane === undefined) throw new Error("Expected a start lane");
    // When preparation emits a compiled Lando command.
    await runWorkflowPerformanceSample({
      lane,
      binary: "/lando",
      rootDir,
      index: 1,
      key: "sample",
      runCommand: async (command) => {
        commands.push(command);
        return { id: command.id, durationMs: 0, exitCode: 1, stdout: "", stderr: "stop after preparation" };
      },
    });
    // Then the command cannot accidentally dispatch as Bun or inherit its reentry guard.
    const setup = commands.find((command) => command.id === "prepare:setup");
    expect(setup).toBeDefined();
    expect(setup?.env.BUN_BE_BUN).toBeUndefined();
    expect(setup?.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBeUndefined();
  } finally {
    if (priorBun === undefined) Reflect.deleteProperty(process.env, "BUN_BE_BUN");
    else process.env.BUN_BE_BUN = priorBun;
    if (priorReentry === undefined) Reflect.deleteProperty(process.env, "LANDO_DISALLOW_BUN_BE_BUN_REENTRY");
    else process.env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY = priorReentry;
    await rm(rootDir, { recursive: true, force: true });
  }
});
