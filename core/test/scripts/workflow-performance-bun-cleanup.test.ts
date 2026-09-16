import { expect, test } from "bun:test";
import { cleanupWorkflowPerformanceSample } from "../../../scripts/workflow-performance-cleanup.ts";
import type { WorkflowPerformanceCommand } from "../../../scripts/workflow-performance-command.ts";

test("selects embedded Bun execution when launching the runtime cleanup script", async () => {
  // Given a sample whose CLI children run in normal Lando mode.
  const commands: WorkflowPerformanceCommand[] = [];
  const env = { LANDO_USER_DATA_ROOT: "/owned/data", BUN_BE_BUN: undefined };
  // When cleanup constructs its child commands.
  await cleanupWorkflowPerformanceSample(
    { binary: "/lando", appRoot: "/owned/apps/app", env, setupOnly: true },
    async (command) => {
      commands.push(command);
      return { id: command.id, durationMs: 0, exitCode: 0, stdout: "", stderr: "" };
    },
  );
  // Then only the TypeScript helper uses Bun re-entry, retaining the owned root.
  expect(commands.find((command) => command.id === "cleanup:global")?.env.BUN_BE_BUN).toBeUndefined();
  expect(commands.find((command) => command.id === "cleanup:runtime")?.env).toMatchObject({
    LANDO_USER_DATA_ROOT: "/owned/data",
    BUN_BE_BUN: "1",
    LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1",
  });
});
