import { describe, expect, test } from "bun:test";

import { buildPublicTranscript, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";
import { renderPublicTranscriptHtml } from "../../src/docs/render/index.ts";

const guideSource = [
  "---",
  "id: render-exclusion",
  "provider: test",
  "---",
  "",
  "<Guide>",
  '  <Scenario id="rendered" render>',
  '    <Step name="visible-step">',
  '      <Run command="lando start" />',
  '      <Variable name="secretvar" value="SHOULD_NOT_RENDER_VAR" display="reader-safe label" />',
  '      <UseFixture name="SHOULD_NOT_RENDER_FIXTURE" />',
  "    </Step>",
  '    <Hidden reason="internal setup not shown to readers">',
  '      <Step name="secret-setup">',
  '        <Run command="echo SHOULD_NOT_RENDER_HIDDEN" />',
  "      </Step>",
  "    </Hidden>",
  "  </Scenario>",
  "",
  '  <Scenario id="notes" render={false} reason="documentation-only scenario covered elsewhere">',
  '    <Step name="notes-step">',
  '      <Variable name="note" value="SHOULD_NOT_RENDER_FALSE" display="hidden notes" />',
  "    </Step>",
  "  </Scenario>",
  "</Guide>",
  "",
].join("\n");

describe("rendered public transcript exclusions", () => {
  test("does not render hidden, fixture, variable, or test-only scenario content into docs HTML", () => {
    const guide = parseGuideScenarioAst("docs/guides/render-exclusion.mdx", guideSource);
    const renderedScenario = guide.scenarios.find((scenario) => scenario.id === "rendered");
    const notesScenario = guide.scenarios.find((scenario) => scenario.id === "notes");

    if (renderedScenario === undefined) throw new Error("expected a rendered scenario");
    if (notesScenario === undefined) throw new Error("expected a notes scenario");

    const transcript = buildPublicTranscript(guide, renderedScenario, undefined);
    if (transcript === undefined) throw new Error("expected a public transcript for the rendered scenario");

    const html = renderPublicTranscriptHtml(transcript);

    expect(html).toContain("visible-step");
    expect(html).toContain("lando start");
    expect(html).not.toContain("SHOULD_NOT_RENDER_VAR");
    expect(html).not.toContain("SHOULD_NOT_RENDER_FIXTURE");
    expect(html).not.toContain("SHOULD_NOT_RENDER_HIDDEN");
    expect(html).not.toContain("secret-setup");
    expect(html).not.toContain("SHOULD_NOT_RENDER_FALSE");

    expect(buildPublicTranscript(guide, notesScenario, undefined)).toBeUndefined();
  });
});
