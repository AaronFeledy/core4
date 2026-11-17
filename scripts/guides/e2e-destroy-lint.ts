import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import type { GuideScenarioAst, GuideStepComponent, GuideStepNode } from "./model.ts";

const DESTROY_FLAGS = new Set(["--volumes", "--purge"]);
const MESSAGE =
  '<Scenario layer="e2e"> must destroy with --volumes or --purge: a plain lando destroy keeps the app\'s volumes, and the next run of this app name from a new root cannot adopt them.';

const commandArgv = (component: GuideStepComponent): ReadonlyArray<string> | undefined =>
  component.kind === "Run" || component.kind === "Verify" ? component.argv : undefined;

const isLandoDestroy = (argv: ReadonlyArray<string>): boolean => argv[0] === "lando" && argv[1] === "destroy";

const cleanupDestroys = (
  steps: ReadonlyArray<GuideStepNode>,
): ReadonlyArray<{ readonly component: GuideStepComponent; readonly purges: boolean }> =>
  steps
    .filter((step) => step.components.some((component) => component.kind === "Cleanup"))
    .flatMap((step) =>
      step.components.flatMap((component) => {
        const argv = commandArgv(component);
        if (argv === undefined || !isLandoDestroy(argv)) return [];
        return [{ component, purges: argv.some((word) => DESTROY_FLAGS.has(word)) }];
      }),
    );

/**
 * Every e2e run starts the app from a fresh root on a shared provider. A cleanup `lando destroy`
 * without `--volumes`/`--purge` keeps the app's volumes, labeled with that root, so the next run
 * of the same app name cannot adopt them. Judge only the commands a cell actually executes: the
 * resolved steps already drop skipped blocks and unselected tabs, and a cell that is skipped
 * wholesale never runs. Cleanup steps are the teardown contract, so a purge elsewhere in the
 * scenario does not remove the volumes of the destroy that runs in cleanup.
 */
export const lintE2eDestroyVolumes = (guide: GuideScenarioAst): ReadonlyArray<GuideLintDiagnostic> => {
  const e2eScenarios = new Set(
    guide.scenarios
      .filter((scenario) => (scenario.layer ?? guide.frontmatter.defaultLayer) === "e2e")
      .map((scenario) => scenario.id),
  );
  const diagnostics: GuideLintDiagnostic[] = [];
  const reported = new Set<number>();
  for (const { scenarioId, resolved } of guide.cells) {
    if (!e2eScenarios.has(scenarioId)) continue;
    if (resolved.variant?.skip !== undefined || resolved.skipOnly) continue;
    const destroys = cleanupDestroys(resolved.steps);
    if (destroys.length === 0 || destroys.some((destroy) => destroy.purges)) continue;
    const [first] = destroys;
    if (first === undefined || reported.has(first.component.line)) continue;
    reported.add(first.component.line);
    diagnostics.push(
      diagnostic(
        guide.sourcePath,
        first.component.source ?? guide.root,
        "guide.scenario.e2e-destroy-volumes",
        MESSAGE,
      ),
    );
  }
  return diagnostics;
};
