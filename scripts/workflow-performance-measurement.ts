import { resolve } from "node:path";

import { buildDrupalJourneyPlan, classifyDrupalJourney } from "./drupal-journey.ts";
import { buildRailsJourneyPlan, classifyRailsJourney } from "./rails-journey.ts";
import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";
import type { WorkflowPerformanceLanePlan } from "./workflow-performance-plan.ts";

export const performanceCommand = (
  id: string,
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): WorkflowPerformanceCommand => ({ id, argv, cwd, env });

export const runUntilFailure = async (
  commands: readonly WorkflowPerformanceCommand[],
  runCommand: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>,
): Promise<readonly WorkflowPerformanceCommandResult[]> => {
  const results: WorkflowPerformanceCommandResult[] = [];
  for (const next of commands) {
    const result = await runCommand(next);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
};

export const buildMeasuredCommands = (input: {
  readonly lane: WorkflowPerformanceLanePlan;
  readonly binary: string;
  readonly appRoot: string;
  readonly fixturePath?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): readonly WorkflowPerformanceCommand[] => {
  const { lane, binary, appRoot, fixturePath, env } = input;
  if (lane.id === "cold-first-start") return [performanceCommand("start", [binary, "start"], appRoot, env)];
  if (lane.id === "warm-stop-start") {
    return [
      performanceCommand("stop", [binary, "stop"], appRoot, env),
      performanceCommand("start", [binary, "start"], appRoot, env),
    ];
  }
  if (lane.id === "unchanged-rebuild") {
    return [performanceCommand("rebuild", [binary, "rebuild"], appRoot, env)];
  }
  if (lane.id.endsWith("-import") && fixturePath !== undefined) {
    return [
      performanceCommand(
        "db:import",
        [binary, "db:import", fixturePath, "--service", "database", "--yes"],
        appRoot,
        env,
      ),
    ];
  }
  if (lane.id.endsWith("-snapshot-restore")) {
    return [
      performanceCommand(
        "db:restore",
        [binary, "db:restore", "workflow-perf-prepared", "--service", "database", "--yes"],
        appRoot,
        env,
      ),
    ];
  }
  const name = appRoot.split("/").at(-1) ?? `${lane.id}-perf`;
  const plan =
    lane.id === "drupal-journey"
      ? buildDrupalJourneyPlan({ binary, name })
      : buildRailsJourneyPlan({ binary, name });
  const parent = resolve(appRoot, "..");
  return plan.map((step) =>
    performanceCommand(step.id, step.argv, step.id === "init" ? parent : appRoot, env),
  );
};

export const validateJourneyResults = (input: {
  readonly lane: WorkflowPerformanceLanePlan;
  readonly binary: string;
  readonly appRoot: string;
  readonly results: readonly WorkflowPerformanceCommandResult[];
}): readonly WorkflowPerformanceCommandResult[] => {
  const { lane, binary, appRoot, results } = input;
  if (lane.id !== "drupal-journey" && lane.id !== "rails-journey") return results;
  const name = appRoot.split("/").at(-1) ?? `${lane.id}-perf`;
  const classification =
    lane.id === "drupal-journey"
      ? classifyDrupalJourney(
          buildDrupalJourneyPlan({ binary, name }).map((step, index) => ({
            id: step.id,
            exitCode: results[index]?.exitCode ?? 1,
            stdout: results[index]?.stdout ?? "",
            stderr: results[index]?.stderr ?? "missing journey step",
          })),
        )
      : classifyRailsJourney(
          buildRailsJourneyPlan({ binary, name }).map((step, index) => ({
            id: step.id,
            exitCode: results[index]?.exitCode ?? 1,
            stdout: results[index]?.stdout ?? "",
            stderr: results[index]?.stderr ?? "missing journey step",
          })),
        );
  return classification.outcome === "passed"
    ? results
    : [
        ...results,
        {
          id: "validate:journey",
          durationMs: 0,
          exitCode: 1,
          stdout: "",
          stderr: classification.reason,
        },
      ];
};
