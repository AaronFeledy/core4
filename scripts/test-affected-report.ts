import type { AffectedGuideRunPlan, PlannedGuideVariant } from "./guides/affected-guide-run.ts";
import type { Selection } from "./test-affected-selection.ts";

const variantSuffix = (variant: PlannedGuideVariant): string => {
  switch (variant.state) {
    case "will-run":
      return variant.layer === "e2e" ? "will run (e2e)" : "will run";
    case "skipped":
      return `skipped (${variant.skip?.kind}: ${variant.skip?.reason})`;
    case "e2e-not-admitted":
      return "e2e not admitted";
  }
};

export const printGuides = (plan: AffectedGuideRunPlan): void => {
  const { summary } = plan;
  console.log(
    `[test-affected] guides=${summary.guides} scenario-variants=${summary.variants} will-run=${summary.willRun} skipped=${summary.skipped} e2e-not-admitted=${summary.e2eNotAdmitted}`,
  );
  for (const guide of plan.guides) {
    console.log(`  guide ${guide.guide} (${guide.guideId}): ${guide.reasons.join("; ")}`);
    for (const variant of guide.variants) {
      const name = `${guide.guideId}:${variant.scenarioId}${variant.label === "" ? "" : ` (${variant.label})`}`;
      console.log(`    ${name}: ${variantSuffix(variant)}`);
    }
  }
  if (plan.e2eCommand !== undefined) {
    console.log(`[test-affected] e2e variants are not admitted. Run them with: ${plan.e2eCommand}`);
    for (const hint of plan.e2eHints) console.log(`[test-affected] ${hint}`);
    if (plan.e2eRunNote !== undefined) console.log(`[test-affected] ${plan.e2eRunNote}`);
  }
};

/** Prints the unit selection, guide-selected paths excluded from the unmatched list. */
export const printUnitSelection = (input: {
  readonly result: Selection;
  readonly base: string;
  readonly explicitPaths: boolean;
  readonly guideSelectedPaths: ReadonlySet<string>;
}): void => {
  const { result } = input;
  console.log(
    `[test-affected] base=${input.base}${input.explicitPaths ? " (explicit paths)" : " (merge-base diff plus untracked)"}`,
  );
  console.log(
    `[test-affected] changed=${result.changed.length} eligible=${result.eligibleCount} selected=${result.selected.length}`,
  );
  console.log("[test-affected] coverage is static/heuristic and partial; CI runs full selected shards.");
  if (result.broadReason) console.log(`[test-affected] broad selection: ${result.broadReason}`);
  for (const test of result.selected) {
    const label = result.fixtureTests.includes(test) ? " (fixture reference heuristic)" : "";
    const prior = result.priorTests.includes(test) ? " (includes base edge)" : "";
    const preload = result.sharedPreloadTests.includes(test)
      ? " (shared test preload)"
      : result.preloadGlobalTests.includes(test)
        ? " (reads a preload-installed global)"
        : "";
    console.log(`  ${test}${label}${prior}${preload}: ${result.witnesses.get(test)?.join(" -> ")}`);
  }
  const unmatched = result.unmatched.filter((path) => !input.guideSelectedPaths.has(path));
  console.log(`[test-affected] unmatched changed paths=${unmatched.length}`);
  for (const path of unmatched) console.log(`  unmatched: ${path}`);
  console.log(`[test-affected] uncertain references=${result.uncertain.length}`);
  for (const path of result.uncertain) console.log(`  uncertain: ${path}`);
};
