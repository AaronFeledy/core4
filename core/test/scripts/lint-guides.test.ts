import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type GuideFixtureInventoryEntry,
  formatGuideLintDiagnostic,
  lintGuideContent,
  lintGuides,
} from "../../../scripts/lint-guides.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "core/test/lint/guides");

const lintFixture = async (name: string): Promise<ReadonlyArray<string>> => {
  const sourcePath = `core/test/lint/guides/${name}.mdx`;
  const content = await readFile(resolve(fixturesRoot, `${name}.mdx`), "utf8");
  return lintGuideContent(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic);
};

const lintFixtureWithInventory = async (
  name: string,
  fixtures: ReadonlyArray<GuideFixtureInventoryEntry>,
): Promise<ReadonlyArray<string>> => {
  const sourcePath = `core/test/lint/guides/${name}.mdx`;
  const content = await readFile(resolve(fixturesRoot, `${name}.mdx`), "utf8");
  return lintGuideContent(sourcePath, content, { fixtures }).diagnostics.map(formatGuideLintDiagnostic);
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

  test("reports duplicate Step names between hidden and visible steps", () => {
    const sourcePath = "core/test/lint/guides/duplicate-hidden-step.mdx";
    const diagnostics = lintGuideContent(
      sourcePath,
      [
        "---",
        "id: duplicate-hidden-step",
        "provider: test",
        "diataxis: tutorial",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="reader-path">',
        '    <Hidden reason="seed deterministic fixtures">',
        '      <Step name="run">',
        '        <Run command="version" />',
        "      </Step>",
        "    </Hidden>",
        '    <Step name="run">',
        '      <Run command="status" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n"),
    ).diagnostics.map(formatGuideLintDiagnostic);

    expect(diagnostics).toEqual([
      'core/test/lint/guides/duplicate-hidden-step.mdx:14:5: guide.step.duplicate-name: Duplicate <Step name="run">.',
    ]);
  });

  test("reports unknown components with a source-mapped frame", async () => {
    const diagnostics = await lintFixture("beta-component");

    expect(diagnostics[0]).toBe(
      "core/test/lint/guides/beta-component.mdx:7:3: guide.component.beta: <Bogus> is not supported in Alpha 2. <Bogus> ships in Phase 3 Beta — see spec/ROADMAP.md.",
    );
  });

  test("accepts a guide with a <Skip> block carrying a reason", async () => {
    expect(await lintFixture("skip-green")).toEqual([]);
  });

  test("reports <Skip> blocks missing or short reasons", async () => {
    expect(await lintFixture("skip-missing-reason")).toEqual([
      "core/test/lint/guides/skip-missing-reason.mdx:9:5: guide.skip.reason: <Skip> requires a `reason` of at least 8 characters per §19.10.",
    ]);
  });

  test("accepts a guide with an <Inline> carrying a justification", async () => {
    expect(await lintFixture("inline-green")).toEqual([]);
  });

  test("reports <Inline> components missing or short justifications", async () => {
    expect(await lintFixture("inline-missing-justification")).toEqual([
      "core/test/lint/guides/inline-missing-justification.mdx:11:7: guide.inline.justification: <Inline> requires a `justification` of at least 8 characters per §19.10.",
    ]);
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

  test("reports unknown components anywhere in prose", async () => {
    const diagnostics = await lintFixture("beta-inline-component");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/beta-inline-component.mdx:9:33: guide.component.beta: <Bogus> is not supported in Alpha 2. <Bogus> ships in Phase 3 Beta — see spec/ROADMAP.md.",
    ]);
  });

  test("reports rendered scenarios in unsupported diataxis buckets", async () => {
    const diagnostics = await lintFixture("bad-diataxis");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/bad-diataxis.mdx:7:1: guide.diataxis: `diataxis:` must be `tutorial` or `how-to` for guides containing rendered scenarios.",
    ]);
  });

  test("accepts a guide whose <Verify> matcher conforms to MatcherSchema", async () => {
    expect(await lintFixture("verify-matcher-green")).toEqual([]);
  });

  test("reports a <Verify> whose expect matcher fails MatcherSchema", async () => {
    const diagnostics = await lintFixture("verify-matcher-bad");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/verify-matcher-bad.mdx:11:7");
    expect(diagnostics[0]).toContain("guide.verify.matcher");
    expect(diagnostics[0]).toContain("Invalid <Verify> props:");
  });

  test("reports duplicate declared axis values via the frontmatter gate", async () => {
    const diagnostics = await lintFixture("axis-duplicate-value");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/axis-duplicate-value.mdx:1:1");
    expect(diagnostics[0]).toContain("guide.frontmatter");
    expect(diagnostics[0]).toContain("Axis values must be unique");
  });

  test("lints a guide root override instead of the repository guide tree", async () => {
    const guideRoot = await mkdtemp(join(tmpdir(), "lando-guide-lint-override-"));
    try {
      await writeFile(
        join(guideRoot, "bad.mdx"),
        [
          "---",
          "id: bad",
          "provider: test",
          "diataxis: tutorial",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path">',
          "    <Hidden>",
          '      <Step name="run"><Run command="status" /></Step>',
          "    </Hidden>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const diagnostics = (await lintGuides(repoRoot, { guideRoot })).diagnostics.map(
        formatGuideLintDiagnostic,
      );

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("bad.mdx:9:5");
      expect(diagnostics[0]).toContain("guide.hidden.reason");
    } finally {
      await rm(guideRoot, { force: true, recursive: true });
    }
  });

  test("reports a <UseFixture> that resolves to no fixture directory", async () => {
    expect(await lintFixtureWithInventory("fixture-demo", [])).toEqual([
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.missing: <UseFixture name="demo"> does not resolve to a fixture directory per §19.9.',
    ]);
  });

  test("reports a <UseFixture> that resolves only to a regular file", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "other",
        },
      ]),
    ).toEqual([
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.missing: <UseFixture name="demo"> does not resolve to a fixture directory per §19.9.',
    ]);
  });

  test("accepts a <UseFixture> that resolves to a directory fixture", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "directory",
        },
      ]),
    ).toEqual([]);
  });

  test("reports a fixture whose source tree contains a symbolic link", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "directory",
          symlinkPaths: ["docs/guides/fixture-demo/fixtures/demo/link"],
        },
      ]),
    ).toEqual([
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.symlink: Fixture "demo" contains a symbolic link at "docs/guides/fixture-demo/fixtures/demo/link" and cannot be copied immutably per §19.9.',
    ]);
  });

  test("reports a fixture whose source root is itself a symbolic link", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "symlink",
        },
      ]),
    ).toEqual([
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.symlink: Fixture "demo" contains a symbolic link at "docs/guides/fixture-demo/fixtures/demo" and cannot be copied immutably per §19.9.',
    ]);
  });

  test("reports a local fixture not referenced by any <UseFixture>", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "directory",
        },
        {
          name: "orphan",
          sourcePath: "docs/guides/fixture-demo/fixtures/orphan",
          scope: "local",
          kind: "directory",
        },
      ]),
    ).toEqual([
      'core/test/lint/guides/fixture-demo.mdx:7:1: guide.fixture.unused: Fixture "orphan" is not referenced by any <UseFixture> in guide "fixture-demo" per §19.10.',
    ]);
  });

  test("does not flag an unreferenced regular file as an unused fixture", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "directory",
        },
        {
          name: "orphan.txt",
          sourcePath: "docs/guides/fixture-demo/fixtures/orphan.txt",
          scope: "local",
          kind: "other",
        },
      ]),
    ).toEqual([]);
  });

  test("does not flag an unreferenced shared fixture as unused", async () => {
    expect(
      await lintFixtureWithInventory("fixture-demo", [
        {
          name: "demo",
          sourcePath: "docs/guides/fixture-demo/fixtures/demo",
          scope: "local",
          kind: "directory",
        },
        {
          name: "shared-extra",
          sourcePath: "docs/guides/fixtures/shared-extra",
          scope: "shared",
          kind: "directory",
        },
      ]),
    ).toEqual([]);
  });
});
