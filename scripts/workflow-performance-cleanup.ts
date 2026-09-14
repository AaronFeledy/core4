import { dirname, join } from "node:path";
import { childEnv } from "../core/src/cli/commands/bun-self-runner.ts";
import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";
import { performanceCommand } from "./workflow-performance-measurement.ts";
import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";
import type { PerformanceStores } from "./workflow-performance-stores.ts";

export const cleanupWorkflowPerformanceSample = async (
  context: {
    readonly binary: string;
    readonly appRoot: string;
    readonly env: WorkflowPerformanceCommand["env"];
    readonly setupOnly: boolean;
    readonly stores?: PerformanceStores;
  },
  runCommand: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>,
): Promise<readonly WorkflowPerformanceCommandResult[]> => {
  const { binary, appRoot, env } = context;
  const started = performance.now();
  try {
    await context.stores?.assertOwned();
  } catch (cause) {
    return [
      {
        id: "cleanup:ownership",
        durationMs: performance.now() - started,
        exitCode: 1,
        stdout: "",
        stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
      },
    ];
  }
  const commands = [
    ...(context.setupOnly
      ? []
      : [performanceCommand("cleanup:destroy", [binary, "destroy", "-y", "--purge"], appRoot, env)]),
    performanceCommand(
      "cleanup:global",
      [binary, "meta:global:destroy", "--yes", "--purge"],
      dirname(appRoot),
      env,
    ),
    performanceCommand(
      "cleanup:runtime",
      [process.execPath, join(import.meta.dir, "workflow-performance-runtime-cleanup.ts")],
      dirname(appRoot),
      childEnv({ ...env }),
    ),
  ];
  const failures: WorkflowPerformanceCommandResult[] = [];
  for (const command of commands) {
    const started = performance.now();
    try {
      const result = await runCommand({ ...command, timeoutMs: 30_000 });
      if (result.exitCode !== 0) failures.push(result);
    } catch (cause) {
      failures.push({
        id: command.id,
        durationMs: performance.now() - started,
        exitCode: 1,
        stdout: "",
        stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
      });
    }
  }
  if (failures.length === 0 && context.stores !== undefined) {
    const started = performance.now();
    try {
      failures.push(
        ...(await context.stores.release(
          runCommand,
          performanceCommand("cleanup:storage", [], appRoot, env),
        )),
      );
    } catch (cause) {
      failures.push({
        id: "cleanup:storage",
        durationMs: performance.now() - started,
        exitCode: 1,
        stdout: "",
        stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
      });
    }
  }
  return failures;
};
