import type { MdxNode } from "./mdx.ts";
import type { GuideScenarioAst } from "./model.ts";

export interface CoverageLintDocument {
  readonly sourcePath: string;
  readonly root: MdxNode;
  readonly content: string;
  readonly guide?: GuideScenarioAst;
}

export function* e2eCommandArgvs(guide: GuideScenarioAst): Generator<readonly string[]> {
  const scenarios = new Set(
    guide.scenarios
      .filter((scenario) => (scenario.layer ?? guide.frontmatter.defaultLayer) === "e2e")
      .map((scenario) => scenario.id),
  );
  for (const { scenarioId, resolved } of guide.cells) {
    if (!scenarios.has(scenarioId) || resolved.variant?.skip !== undefined || resolved.skipOnly) continue;
    for (const step of resolved.steps)
      for (const component of step.components)
        if ((component.kind === "Run" || component.kind === "Verify") && component.argv !== undefined)
          yield component.argv;
  }
}
