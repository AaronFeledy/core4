import { expect, test } from "bun:test";
import { parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";

const hidden = 'render={false} reason="Exercise hidden scenario fault handling"';
const routerFault = 'faults={["router.apply-routes"]}';

test.each([
  ["unlisted fault", `${hidden} faults={["router.setup"]}`, "scenario", "GuidePropError"],
  ["visible scenario", routerFault, "scenario", "GuidePropError"],
  ["explicit e2e layer", `${hidden} ${routerFault} layer="e2e"`, "scenario", "GuideSemanticError"],
  ["inherited e2e layer", `${hidden} ${routerFault}`, "e2e", "GuideSemanticError"],
] as const)("rejects fault injection for %s", (_case, props, defaultLayer, tag) => {
  const guide = `---
id: scenario-faults
provider: test
defaultLayer: ${defaultLayer}
---
<Guide>
  <Scenario id="faults" ${props}>
    <Step name="run">
      <Run command="lando version" />
    </Step>
  </Scenario>
</Guide>`;

  expect(() => parseGuideScenarioAst("docs/guides/scenario-faults.mdx", guide)).toThrow(
    expect.objectContaining({ _tag: tag, component: "Scenario" }),
  );
});
