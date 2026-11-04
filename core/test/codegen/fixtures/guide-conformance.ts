import {
  buildPublicTranscript,
  parseGuideScenarioAst,
  renderScenarioTest,
  variantsOf,
} from "../../../../scripts/build-guide-scenarios.ts";
import { stripRecipeReadme } from "../../../../scripts/build-recipe-readmes.ts";
import { lintGuideContent } from "../../../../scripts/lint-guides.ts";

export const SOURCE = "recipes/conformance/README.mdx";
export const document = (body: string, frontmatter = ""): string =>
  `---\nid: conformance\nprovider: test\n${frontmatter}---\n\n<Guide>\n${body}\n</Guide>\n`;
export const scenario = (body: string, id = "reader"): string =>
  `<Scenario id="${id}">\n${body}\n</Scenario>`;
export const step = (body: string, name = "run"): string => `<Step name="${name}">\n${body}\n</Step>`;
export const project = (source: string) => {
  const guide = parseGuideScenarioAst(SOURCE, source);
  const cells = guide.scenarios.flatMap((node) =>
    variantsOf(guide).map((variant) => ({
      scenario: node.id,
      variant,
      test: renderScenarioTest(guide, node, variant, "linux"),
      transcript: buildPublicTranscript(guide, node, variant),
    })),
  );
  return {
    guide,
    cells,
    readmes: stripRecipeReadme(SOURCE, source),
    lint: lintGuideContent(SOURCE, source).diagnostics,
  };
};
export const consumers = [
  {
    name: "executable",
    run: (source: string) => {
      const guide = parseGuideScenarioAst(SOURCE, source);
      return guide.scenarios.flatMap((node) =>
        variantsOf(guide).map((variant) => renderScenarioTest(guide, node, variant, "linux")),
      );
    },
  },
  {
    name: "transcript",
    run: (source: string) => {
      const guide = parseGuideScenarioAst(SOURCE, source);
      return guide.scenarios.flatMap((node) =>
        variantsOf(guide).map((variant) => buildPublicTranscript(guide, node, variant)),
      );
    },
  },
  { name: "scaffold", run: (source: string) => stripRecipeReadme(SOURCE, source) },
] as const;
