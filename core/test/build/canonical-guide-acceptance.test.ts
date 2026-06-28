import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type GuideScenarioAst,
  type GuideScenarioNode,
  buildPublicTranscript,
  parseGuideScenarioAst,
  renderScenarioTest,
} from "../../../scripts/build-guide-scenarios.ts";
import { renderPublicTranscriptHtml } from "../../src/docs/render/index.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guidePath = "docs/guides/recipes/canonical-public-transcript.mdx";

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const scenarioById = (guide: GuideScenarioAst, id: string): GuideScenarioNode => {
  const scenario = guide.scenarios.find((candidate) => candidate.id === id);
  expect(scenario, `expected scenario ${id}`).toBeDefined();
  if (scenario === undefined) throw new Error(`expected scenario ${id}`);
  return scenario;
};

describe("Canonical guide acceptance path", () => {
  test("publishes the accepted guide row as shipped", async () => {
    const index = await readText("docs/guides/INDEX.md");

    expect(index).toContain(
      "| PRD-07 | US-250 | canonical recipe guide acceptance path | `docs/guides/recipes/canonical-public-transcript.mdx` | Shipped |",
    );
  });

  test("proves public transcript rendering, library mode, and e2e smoke in one canonical guide", async () => {
    const guide = parseGuideScenarioAst(guidePath, await readText(guidePath));

    const publicScenario = scenarioById(guide, "public-transcript-docs-render");
    const publicTranscript = buildPublicTranscript(guide, publicScenario, undefined);
    expect(publicTranscript, "expected the rendered scenario to emit a public transcript").toBeDefined();
    if (publicTranscript === undefined) throw new Error("expected public transcript");
    const html = renderPublicTranscriptHtml(publicTranscript);
    expect(html).toContain("public-transcript");
    expect(html).toContain("docs/guides/recipes/canonical-public-transcript.mdx");

    const libraryScenario = scenarioById(guide, "library-runtime-api");
    const libraryRun = libraryScenario.steps
      .flatMap((step) => step.components)
      .find(
        (component) =>
          component.kind === "Run" && "runtime" in component.props && component.props.runtime === "library",
      );
    expect(libraryRun, "expected a library-mode Run component").toBeDefined();
    if (libraryRun?.kind !== "Run" || !("runtime" in libraryRun.props)) {
      throw new Error("expected a library-mode Run component");
    }
    expect(libraryRun.props.code).toContain("LandoCore.FileSystem");
    expect(libraryRun.props.displayCode).toContain('from "@lando/core"');

    const libraryGenerated = renderScenarioTest(guide, libraryScenario, undefined, "linux");
    expect(libraryGenerated).toContain('import * as LandoCore from "@lando/core";');
    expect(libraryGenerated).toContain("LandoTesting.withScenarioContext(");
    expect(libraryGenerated).not.toContain("context.runCli(");

    const smokeScenario = scenarioById(guide, "provider-e2e-smoke");
    expect(smokeScenario).toMatchObject({ layer: "e2e" });
    expect(smokeScenario.tags).toContain("@smoke");
    expect(
      smokeScenario.steps
        .flatMap((step) => step.components)
        .some((component) => component.kind === "Cleanup"),
    ).toBe(true);

    const smokeGenerated = renderScenarioTest(guide, smokeScenario, undefined, "linux");
    expect(smokeGenerated).toContain("// @tags: beta,docs,recipes,transcripts,@smoke");
    expect(smokeGenerated).toContain("// @layer: e2e");
    expect(smokeGenerated).toContain('LANDO_GUIDE_E2E === "1"');
    expect(smokeGenerated).toContain("LANDO_SCENARIO_E2E_BINARY !== undefined");
    expect(smokeGenerated).not.toContain("LANDO_TEST_PODMAN_SOCKET");
    expect(smokeGenerated).toContain(
      '"beta docs recipes transcripts @smoke canonical-public-transcript:provider-e2e-smoke [e2e]"',
    );
    const smokeTranscript = buildPublicTranscript(guide, smokeScenario, undefined);
    expect(smokeTranscript?.runtime).toBe("e2e");
  });
});
