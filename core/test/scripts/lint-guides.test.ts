import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { formatGuideLintDiagnostic, lintGuideContent } from "../../../scripts/lint-guides.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "core/test/lint/guides");

const lintFixture = async (name: string): Promise<ReadonlyArray<string>> => {
  const sourcePath = `core/test/lint/guides/${name}.mdx`;
  const content = await readFile(resolve(fixturesRoot, `${name}.mdx`), "utf8");
  return lintGuideContent(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic);
};

describe("lint:guides", () => {
  test("accepts a guide satisfying all Alpha 2 rules", async () => {
    expect(await lintFixture("green")).toEqual([]);
  });

  test("reports invalid frontmatter with a source-mapped frame", async () => {
    const diagnostics = await lintFixture("invalid-frontmatter");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/invalid-frontmatter.mdx:1:1");
    expect(diagnostics[0]).toContain("guide.frontmatter");
  });

  test("reports duplicate Scenario ids within one guide", async () => {
    const diagnostics = await lintFixture("duplicate-scenario");

    expect(diagnostics).toEqual([
      'core/test/lint/guides/duplicate-scenario.mdx:12:3: guide.scenario.duplicate-id: Duplicate <Scenario id="reader-path">.',
    ]);
  });

  test("reports missing or short test-only Scenario reasons", async () => {
    const diagnostics = await lintFixture("missing-hidden-reason");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/missing-hidden-reason.mdx:7:3: guide.scenario.hidden-reason: <Scenario render={false}> requires a `reason` of at least 8 characters per §19.9.",
    ]);
  });

  test("accepts a guide with a <Hidden> block carrying a reason", async () => {
    expect(await lintFixture("hidden-green")).toEqual([]);
  });

  test("reports <Hidden> blocks missing a reason", async () => {
    expect(await lintFixture("hidden-missing-reason")).toEqual([
      "core/test/lint/guides/hidden-missing-reason.mdx:9:5: guide.hidden.reason: <Hidden> requires a `reason` of at least 8 characters per §19.10.",
    ]);
  });

  test("reports duplicate Step names within one scenario", async () => {
    const diagnostics = await lintFixture("duplicate-step");

    expect(diagnostics).toEqual([
      'core/test/lint/guides/duplicate-step.mdx:11:5: guide.step.duplicate-name: Duplicate <Step name="run">.',
    ]);
  });

  test("reports Beta-only components with a source-mapped frame", async () => {
    const diagnostics = await lintFixture("beta-component");

    expect(diagnostics[0]).toBe(
      "core/test/lint/guides/beta-component.mdx:7:3: guide.component.beta: <Skip> is not supported in Alpha 2. <Skip> ships in Phase 3 Beta — see spec/ROADMAP.md.",
    );
  });

  test("accepts a guide declaring single-axis tabs", async () => {
    expect(await lintFixture("tabs-green")).toEqual([]);
  });

  test("reports <Tabs> usage without a declared axis", async () => {
    const diagnostics = await lintFixture("tabs-missing-axis");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/tabs-missing-axis.mdx:8:5: guide.tabs.missing-axis: <Tabs> requires a `tabs:` or `axes:` axis declaration in frontmatter.",
    ]);
  });

  test("reports <Tab> names that are not a declared axis value", async () => {
    const diagnostics = await lintFixture("tabs-unknown-value");

    expect(diagnostics).toEqual([
      'core/test/lint/guides/tabs-unknown-value.mdx:10:7: guide.tabs.missing-axis: <Tab name="windows"> is not a declared `tabs:` value.',
    ]);
  });

  test("reports duplicate <Tab> names within one block", async () => {
    const diagnostics = await lintFixture("tabs-duplicate");

    expect(diagnostics).toEqual([
      'core/test/lint/guides/tabs-duplicate.mdx:15:7: guide.tabs.duplicate-id: Duplicate <Tab name="linux"> within a <Tabs> block.',
    ]);
  });

  test("accepts a guide declaring multi-axis `axes:`", async () => {
    expect(await lintFixture("axes-green")).toEqual([]);
  });

  test("reports <Tabs> without an `axis` when multiple axes are declared", async () => {
    expect(await lintFixture("axes-missing-prop")).toEqual([
      "core/test/lint/guides/axes-missing-prop.mdx:11:5: guide.tabs.missing-axis: <Tabs> requires an `axis` attribute because this guide declares multiple axes.",
    ]);
  });

  test("reports <Tabs axis> referencing an undeclared axis", async () => {
    expect(await lintFixture("axes-unknown-axis")).toEqual([
      'core/test/lint/guides/axes-unknown-axis.mdx:10:5: guide.tabs.unknown-axis: <Tabs axis="arch"> is not a declared `axes:` axis.',
    ]);
  });

  test("reports <Tab> names that are not a declared axis value", async () => {
    expect(await lintFixture("axes-unknown-value")).toEqual([
      'core/test/lint/guides/axes-unknown-value.mdx:11:7: guide.tabs.missing-axis: <Tab name="windows"> is not a declared `os` axis value.',
    ]);
  });

  test("reports `tabs:` and `axes:` declared together", async () => {
    const diagnostics = await lintFixture("tabs-and-axes");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/tabs-and-axes.mdx:1:1");
    expect(diagnostics[0]).toContain("guide.frontmatter");
    expect(diagnostics[0]).toContain("mutually exclusive");
  });

  test("reports inline Beta-only components anywhere in prose", async () => {
    const diagnostics = await lintFixture("beta-inline-component");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/beta-inline-component.mdx:9:33: guide.component.beta: <Inline> is not supported in Alpha 2. <Inline> ships in Phase 3 Beta — see spec/ROADMAP.md.",
    ]);
  });

  test("reports rendered scenarios in unsupported diataxis buckets", async () => {
    const diagnostics = await lintFixture("bad-diataxis");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/bad-diataxis.mdx:7:1: guide.diataxis: `diataxis:` must be `tutorial` or `how-to` for guides containing rendered scenarios.",
    ]);
  });
});
