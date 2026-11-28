import type { AffectedGuideRunPlan } from "./guides/affected-guide-run.ts";
import { notExecutedReason } from "./guides/affected-guide-run.ts";
import { withRunnerOwnedTestRoots } from "./test-preload-roots.ts";

export const affectedTestCommand = (selected: readonly string[]): readonly string[] => [
  process.execPath,
  "--no-orphans",
  "test",
  "--timeout=20000",
  ...selected.map((path) => `./${path}`),
];

/**
 * Live-provider and real-root opt-ins. Unit tests are not live suites, so the
 * unit child never inherits them, matching CI's unit shard environment.
 */
const LIVE_TEST_ENVIRONMENT = [
  "LANDO_GUIDE_E2E",
  "LANDO_SCENARIO_E2E_BINARY",
  "LANDO_TEST_PODMAN_SOCKET",
  "LANDO_TEST_DOCKER_SOCKET",
  "LANDO_TEST_WINDOWS_DOCKER_SOCKET",
  "LANDO_TEST_USE_REAL_ROOTS",
] as const;

/** The caller's environment without the live-test opt-ins, for the unit child. */
export const unitTestEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !LIVE_TEST_ENVIRONMENT.some((withheld) => withheld === name)),
  );

/**
 * A run that executes nothing must fail; a run that executed units or guide
 * variants succeeds and reports whatever did not run.
 */
export const affectedRunOutcome = (plan: AffectedGuideRunPlan, unitsRan: boolean): 0 | 1 =>
  unitsRan || plan.command !== undefined ? 0 : 1;

/** The lines a run with nothing executed prints before it exits nonzero. */
export const nothingExecutedReport = (plan: AffectedGuideRunPlan): readonly string[] => {
  const reason =
    plan.guides.length > 0 && plan.summary.variants === 0
      ? "the selected guides have no scenario variants"
      : notExecutedReason(plan.summary);
  return [
    `[test-affected] nothing was executed: ${reason}.`,
    ...(plan.e2eCommand === undefined
      ? []
      : [`[test-affected] ${plan.e2eCommand}`, ...plan.e2eHints.map((hint) => `[test-affected] ${hint}`)]),
  ];
};

const spawnWithSignals = async (
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<number> => {
  const child = Bun.spawn([...command], { cwd, env, stdout: "inherit", stderr: "inherit" });
  const cancel = (): void => child.kill();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const code = await child.exited;
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  return code;
};

/** Runs the selected unit files, then the guide pass, and reports what did not run. */
export const runAffectedChildren = async (input: {
  readonly root: string;
  readonly unitFiles: readonly string[];
  readonly plan: AffectedGuideRunPlan;
  readonly env: NodeJS.ProcessEnv;
}): Promise<number> => {
  let executed = false;
  if (input.unitFiles.length > 0) {
    executed = true;
    const unitCode = await withRunnerOwnedTestRoots(
      { env: unitTestEnvironment(input.env), live: false },
      (env) => spawnWithSignals(affectedTestCommand(input.unitFiles), env, input.root),
    );
    if (unitCode !== 0) return unitCode;
  }
  if (input.plan.command !== undefined) {
    // The guide child keeps the caller's environment so dev:guides can allocate live roots.
    const guideCode = await spawnWithSignals(input.plan.command, input.plan.env, input.root);
    if (guideCode !== 0) return guideCode;
    executed = true;
  }
  if (affectedRunOutcome(input.plan, executed) !== 0) {
    for (const line of nothingExecutedReport(input.plan)) console.log(line);
    return 1;
  }
  if (input.plan.notRun !== undefined) {
    console.log(`[test-affected] ${input.plan.notRun}`);
    if (input.plan.e2eCommand !== undefined) {
      console.log(`[test-affected] ${input.plan.e2eCommand}`);
      for (const hint of input.plan.e2eHints) console.log(`[test-affected] ${hint}`);
    }
  }
  return 0;
};
