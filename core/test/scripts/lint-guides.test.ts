import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { buildPublicTranscript, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";
import { classifiedFormFor, validateClassified } from "../../../scripts/lint-guides-yaml-fence.ts";
import { lintFixtureLandofiles } from "../../../scripts/lint-guides-yaml-fixtures.ts";
import {
  type GuideFixtureInventoryEntry,
  checkScenarioSourceMap,
  checkTranscriptFrameDiscipline,
  formatGuideLintDiagnostic,
  lintGuideContent,
  lintGuideTranscripts,
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
  test("accepts a guide satisfying all rules", async () => {
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
      expect.stringContaining(
        "core/test/lint/guides/duplicate-scenario.mdx:12:1: guide.scenario.duplicate-id:",
      ),
    ]);
  });

  test("reports missing or short test-only Scenario reasons", async () => {
    const diagnostics = await lintFixture("missing-hidden-reason");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/missing-hidden-reason.mdx:7:3: guide.scenario.hidden-reason: <Scenario render={false}> requires a `reason` of at least 8 characters.",
    ]);
  });

  test("requires e2e scenarios to carry cleanup", () => {
    const sourcePath = "core/test/lint/guides/e2e-smoke.mdx";
    const green = lintGuideContent(
      sourcePath,
      [
        "---",
        "id: e2e-smoke",
        "provider: test",
        "defaultLayer: e2e",
        'tags: ["@smoke"]',
        "diataxis: tutorial",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="provider-path">',
        '    <Step name="version">',
        '      <Run command="version" />',
        "    </Step>",
        '    <Step name="teardown">',
        "      <Cleanup />",
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n"),
    ).diagnostics.map(formatGuideLintDiagnostic);
    expect(green).toEqual([]);

    const missingCleanup = lintGuideContent(
      sourcePath,
      [
        "---",
        "id: e2e-smoke",
        "provider: test",
        "defaultLayer: e2e",
        "diataxis: tutorial",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="provider-path">',
        '    <Step name="version">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n"),
    ).diagnostics.map(formatGuideLintDiagnostic);

    expect(missingCleanup).toEqual([
      'core/test/lint/guides/e2e-smoke.mdx:9:3: guide.scenario.e2e-cleanup: <Scenario layer="e2e"> requires at least one <Cleanup> step so provider resources are torn down.',
    ]);
  });

  test("accepts a guide with a <Hidden> block carrying a reason", async () => {
    expect(await lintFixture("hidden-green")).toEqual([]);
  });

  test("reports <Hidden> blocks missing a reason", async () => {
    expect(await lintFixture("hidden-missing-reason")).toEqual([
      "core/test/lint/guides/hidden-missing-reason.mdx:9:5: guide.hidden.reason: <Hidden> requires a `reason` of at least 8 characters.",
    ]);
  });

  test("reports duplicate Step names within one scenario", async () => {
    const diagnostics = await lintFixture("duplicate-step");

    expect(diagnostics).toEqual([
      expect.stringContaining("core/test/lint/guides/duplicate-step.mdx:11:1: guide.step.duplicate-name:"),
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
      expect.stringContaining(
        "core/test/lint/guides/duplicate-hidden-step.mdx:14:1: guide.step.duplicate-name:",
      ),
    ]);
  });

  test("reports unknown components with a source-mapped frame", async () => {
    const diagnostics = await lintFixture("unsupported-component");

    expect(diagnostics[0]).toBe(
      "core/test/lint/guides/unsupported-component.mdx:7:3: guide.component.unsupported: <Bogus> is not supported yet.",
    );
  });

  test("accepts a guide with a <Skip> block carrying a reason", async () => {
    expect(await lintFixture("skip-green")).toEqual([]);
  });

  test("reports <Skip> blocks missing or short reasons", async () => {
    expect(await lintFixture("skip-missing-reason")).toEqual([
      "core/test/lint/guides/skip-missing-reason.mdx:9:5: guide.skip.reason: <Skip> requires a `reason` of at least 8 characters.",
    ]);
  });

  test("accepts a guide with an <Inline> carrying a justification", async () => {
    expect(await lintFixture("inline-green")).toEqual([]);
  });

  test("reports <Inline> components missing or short justifications", async () => {
    expect(await lintFixture("inline-missing-justification")).toEqual([
      "core/test/lint/guides/inline-missing-justification.mdx:11:7: guide.inline.justification: <Inline> requires a `justification` of at least 8 characters.",
    ]);
  });

  test("accepts a guide declaring single-axis tabs", async () => {
    expect(await lintFixture("tabs-green")).toEqual([]);
  });

  test("reports <Tabs> usage without a declared axis", async () => {
    const diagnostics = await lintFixture("tabs-missing-axis");

    expect(diagnostics).toEqual([
      expect.stringContaining("core/test/lint/guides/tabs-missing-axis.mdx:8:1: guide.tabs.missing-axis:"),
    ]);
  });

  test("reports <Tab> names that are not a declared axis value", async () => {
    const diagnostics = await lintFixture("tabs-unknown-value");

    expect(diagnostics).toEqual([
      expect.stringContaining("core/test/lint/guides/tabs-unknown-value.mdx:10:1: guide.tabs.unknown-value:"),
    ]);
  });

  test("reports duplicate <Tab> names within one block", async () => {
    const diagnostics = await lintFixture("tabs-duplicate");

    expect(diagnostics).toEqual([
      expect.stringContaining("core/test/lint/guides/tabs-duplicate.mdx:15:1: guide.tabs.duplicate-id:"),
    ]);
  });

  test("accepts a guide declaring multi-axis `axes:`", async () => {
    expect(await lintFixture("axes-green")).toEqual([]);
  });

  test("reports <Tabs> without an `axis` when multiple axes are declared", async () => {
    expect(await lintFixture("axes-missing-prop")).toEqual([
      expect.stringContaining("core/test/lint/guides/axes-missing-prop.mdx:11:1: guide.tabs.missing-axis:"),
    ]);
  });

  test("reports <Tabs axis> referencing an undeclared axis", async () => {
    expect(await lintFixture("axes-unknown-axis")).toEqual([
      expect.stringContaining("core/test/lint/guides/axes-unknown-axis.mdx:10:1: guide.tabs.unknown-axis:"),
    ]);
  });

  test("reports <Tab> names that are not a declared axis value", async () => {
    expect(await lintFixture("axes-unknown-value")).toEqual([
      expect.stringContaining("core/test/lint/guides/axes-unknown-value.mdx:11:1: guide.tabs.unknown-value:"),
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
    const diagnostics = await lintFixture("unsupported-inline-component");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/unsupported-inline-component.mdx:9:33: guide.component.unsupported: <Bogus> is not supported yet.",
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
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.missing: <UseFixture name="demo"> does not resolve to a fixture directory.',
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
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.missing: <UseFixture name="demo"> does not resolve to a fixture directory.',
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
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.symlink: Fixture "demo" contains a symbolic link at "docs/guides/fixture-demo/fixtures/demo/link" and cannot be copied immutably.',
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
      'core/test/lint/guides/fixture-demo.mdx:10:7: guide.fixture.symlink: Fixture "demo" contains a symbolic link at "docs/guides/fixture-demo/fixtures/demo" and cannot be copied immutably.',
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
      'core/test/lint/guides/fixture-demo.mdx:7:1: guide.fixture.unused: Fixture "orphan" is not referenced by any <UseFixture> in guide "fixture-demo".',
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

  test("forbids raw fenced shell blocks inside <Scenario> but allows them in prose", async () => {
    const diagnostics = await lintFixture("shell-fence");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/shell-fence.mdx:26:1: guide.shell-fence: Raw fenced `bash` code block is not allowed inside <Scenario>; use <Run> or <Inline>.",
    ]);
  });

  test("reports invalid full Landofile yaml fences", async () => {
    const diagnostics = await lintFixture("yaml-fence-bad-full");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/yaml-fence-bad-full.mdx:10:1: guide.yaml-fence.invalid: notARealKey: Expected no excess property",
    ]);
  });

  test("reports invalid Landofile fragment yaml fences", async () => {
    const diagnostics = await lintFixture("yaml-fence-bad-fragment");

    expect(diagnostics).toEqual([
      "core/test/lint/guides/yaml-fence-bad-fragment.mdx:10:1: guide.yaml-fence.invalid: services.web.notARealServiceKey: Expected no excess property",
    ]);
  });

  test("accepts bare service bodies wrapped as services.x fragments", async () => {
    expect(await lintFixture("yaml-fence-bare-service")).toEqual([]);
  });

  test("accepts GlobalConfig-only yaml fences", async () => {
    expect(await lintFixture("yaml-fence-global-config")).toEqual([]);
  });

  test("skips yaml fences marked nolint", async () => {
    expect(await lintFixture("yaml-fence-nolint")).toEqual([]);
  });

  test("reports Landofile flow-map parse errors on yaml fences", async () => {
    const diagnostics = await lintFixture("yaml-fence-flow-map");

    expect(diagnostics).toEqual([
      [
        "core/test/lint/guides/yaml-fence-flow-map.mdx:11:11: guide.yaml-fence.parse: Inline objects are not supported in Landofiles at line 2. Use an indented block mapping instead. Rewrite the flow mapping as a block mapping:",
        "services:",
        "  web: lando",
      ].join("\n"),
    ]);
  });

  test("accepts valid full, fragment, bare-service, global, and skipped yaml fences", async () => {
    expect(await lintFixture("yaml-fence-good")).toEqual([]);
  });

  test("reports invalid fixture .lando.local.yml via inventory with file:line:col format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lint-guides-yaml-inv-"));
    try {
      const fixtureDir = join(dir, "docs/guides/probe/fixtures/app");
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        join(fixtureDir, ".lando.yml"),
        ["name: ok", "services:", "  web:", "    type: lando", ""].join("\n"),
      );
      await writeFile(
        join(fixtureDir, ".lando.local.yml"),
        ["services:", "  web:", "    notARealServiceKey: true", ""].join("\n"),
      );
      await writeFile(join(fixtureDir, ".lando.ts"), "export default {}\n");
      const diagnostics: Array<{
        sourcePath: string;
        line: number;
        column: number;
        code: string;
        message: string;
      }> = [];
      await lintFixtureLandofiles(
        dir,
        [
          {
            name: "app",
            sourcePath: "docs/guides/probe/fixtures/app",
            scope: "local",
            kind: "directory",
          },
        ],
        diagnostics,
      );
      expect(diagnostics.map(formatGuideLintDiagnostic)).toEqual([
        "docs/guides/probe/fixtures/app/.lando.local.yml:1:1: guide.fixture.landofile-invalid: services.web.notARealServiceKey: Expected no excess property",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fixture formOverride never skips arrays or scalars (decode fails instead)", () => {
    expect(classifiedFormFor([], "fragment")).toEqual({ kind: "fragment", value: [] });
    expect(classifiedFormFor("scalar", "fragment")).toEqual({ kind: "fragment", value: "scalar" });
    expect(classifiedFormFor(42, "full")).toEqual({ kind: "full" });

    const diagnostics: Array<{
      sourcePath: string;
      line: number;
      column: number;
      code: string;
      message: string;
    }> = [];
    const fence = { type: "code", position: { start: { line: 0, column: 1 } } };
    validateClassified(
      {
        sourcePath: "fixtures/app/.lando.local.yml",
        fence,
        diagnostics,
        code: "guide.fixture.landofile-invalid",
      },
      [],
      classifiedFormFor([], "fragment"),
    );
    expect(diagnostics.map(formatGuideLintDiagnostic)).toEqual([
      "fixtures/app/.lando.local.yml:1:1: guide.fixture.landofile-invalid: Expected object",
    ]);
  });

  test("lintGuides discovers fixture inventory and reports invalid .lando.local.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lint-guides-yaml-lg-"));
    try {
      const guideRoot = "guides";
      const fixtureDir = join(dir, guideRoot, "probe", "fixtures", "app");
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        join(dir, guideRoot, "probe.mdx"),
        [
          "---",
          "id: probe",
          "provider: test",
          "diataxis: tutorial",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path">',
          '    <Step name="scaffold">',
          '      <UseFixture name="app" />',
          "    </Step>",
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(fixtureDir, ".lando.yml"),
        ["name: ok", "services:", "  web:", "    type: lando", ""].join("\n"),
      );
      await writeFile(
        join(fixtureDir, ".lando.local.yml"),
        ["services:", "  web:", "    notARealServiceKey: true", ""].join("\n"),
      );
      const diagnostics = (await lintGuides(dir, { guideRoot })).diagnostics.map(formatGuideLintDiagnostic);
      expect(diagnostics).toEqual([
        "guides/probe/fixtures/app/.lando.local.yml:1:1: guide.fixture.landofile-invalid: services.web.notARealServiceKey: Expected no excess property",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("requires every <Run> to declare a display-vs-execute binding", async () => {
    const diagnostics = await lintFixture("run-binding-bad");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/run-binding-bad.mdx:10:7");
    expect(diagnostics[0]).toContain("guide.run.binding");
  });

  test("rejects a library <Run> missing its explicit displayCode binding", () => {
    const sourcePath = "core/test/lint/guides/run-library-missing-display.mdx";
    const diagnostics = lintGuideContent(
      sourcePath,
      [
        "---",
        "id: run-library-missing-display",
        "provider: test",
        "diataxis: tutorial",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="reader-path">',
        '    <Step name="library">',
        '      <Run runtime="library" code={`expect(1).toBe(1);`} />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n"),
    ).diagnostics.map(formatGuideLintDiagnostic);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("run-library-missing-display.mdx:10:7");
    expect(diagnostics[0]).toContain("guide.run.binding");
  });

  test("accepts valid cli, shell, and library <Run> bindings including backtick code", async () => {
    expect(await lintFixture("run-binding-green")).toEqual([]);
  });

  test("validates props for components without a dedicated rule (e.g. <Variable>)", async () => {
    const diagnostics = await lintFixture("component-props-bad");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("core/test/lint/guides/component-props-bad.mdx:9:5");
    expect(diagnostics[0]).toContain("guide.component.props");
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

  test("excludes hidden, variable, and fixture content from public transcript frames", () => {
    const sourcePath = "core/test/lint/guides/transcript-discipline.mdx";
    const content = [
      "---",
      "id: transcript-discipline",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="run">',
      '      <Variable name="secret" value="hunter2" />',
      '      <Run command="version {{secret}}" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    const guide = parseGuideScenarioAst(sourcePath, content);
    const scenario = guide.scenarios[0];
    if (scenario === undefined) throw new Error("expected a scenario");

    const realTranscript = buildPublicTranscript(guide, scenario, undefined);
    if (realTranscript === undefined) throw new Error("expected a public transcript");
    expect(
      checkTranscriptFrameDiscipline(scenario, realTranscript.frames, sourcePath).map(
        formatGuideLintDiagnostic,
      ),
    ).toEqual([]);

    const leaked = [...realTranscript.frames, { kind: "run", sourceFile: sourcePath, sourceLine: 9 }];
    const leakDiagnostics = checkTranscriptFrameDiscipline(scenario, leaked, sourcePath).map(
      formatGuideLintDiagnostic,
    );
    expect(leakDiagnostics).toHaveLength(1);
    expect(leakDiagnostics[0]).toContain("transcript-discipline.mdx:9:1");
    expect(leakDiagnostics[0]).toContain("guide.transcript.leak");
  });

  test("requires generated scenario blocks to carry source-map headers", () => {
    const sourcePath = "docs/guides/example.mdx";
    const withHeaders = [
      "// @generated",
      "// @source: docs/guides/example.mdx:8",
      "// @scenario: reader-path",
      "// @variant:",
      "",
      "test('reader-path', () => {});",
    ].join("\n");
    expect(checkScenarioSourceMap(withHeaders, sourcePath, 8).map(formatGuideLintDiagnostic)).toEqual([]);

    const missing = ["import { test } from 'bun:test';", "test('reader-path', () => {});"].join("\n");
    const diagnostics = checkScenarioSourceMap(missing, sourcePath, 8).map(formatGuideLintDiagnostic);
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics[0]).toContain("docs/guides/example.mdx:8:1");
    expect(diagnostics[0]).toContain("guide.transcript.source-map");
  });

  test("rejects source-map headers that point at a different guide", () => {
    const sourcePath = "docs/guides/example.mdx";
    const wrongPath = [
      "// @generated",
      "// @source: docs/guides/other.mdx:8",
      "// @scenario: reader-path",
      "// @variant:",
    ].join("\n");
    const diagnostics = checkScenarioSourceMap(wrongPath, sourcePath, 8).map(formatGuideLintDiagnostic);
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics.every((entry) => entry.includes("guide.transcript.source-map"))).toBe(true);
    expect(diagnostics.some((entry) => entry.includes("does not point at docs/guides/example.mdx"))).toBe(
      true,
    );
  });

  test("rejects a scenario source-map header whose line does not anchor the scenario", () => {
    const sourcePath = "docs/guides/example.mdx";
    const wrongLine = [
      "// @generated",
      "// @source: docs/guides/example.mdx:99",
      "// @scenario: reader-path",
      "// @variant:",
    ].join("\n");
    const diagnostics = checkScenarioSourceMap(wrongLine, sourcePath, 8).map(formatGuideLintDiagnostic);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("guide.transcript.source-map");
    expect(diagnostics[0]).toContain("docs/guides/example.mdx:8");
  });

  test("flags a public transcript frame that maps to a different source file", () => {
    const sourcePath = "core/test/lint/guides/transcript-cross-file.mdx";
    const content = [
      "---",
      "id: transcript-cross-file",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="run">',
      '      <Run command="version" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    const guide = parseGuideScenarioAst(sourcePath, content);
    const scenario = guide.scenarios[0];
    if (scenario === undefined) throw new Error("expected a scenario");
    const transcript = buildPublicTranscript(guide, scenario, undefined);
    if (transcript === undefined) throw new Error("expected a public transcript");

    const foreign = transcript.frames.map((frame) => ({ ...frame, sourceFile: "docs/guides/other.mdx" }));
    const diagnostics = checkTranscriptFrameDiscipline(scenario, foreign, sourcePath).map(
      formatGuideLintDiagnostic,
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(diagnostics[0]).toContain("guide.transcript.leak");
  });

  test("passes transcript discipline and source-map coverage on a clean guide", () => {
    const sourcePath = "core/test/lint/guides/transcript-clean.mdx";
    const content = [
      "---",
      "id: transcript-clean",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="run">',
      '      <Run command="version" />',
      "    </Step>",
      "  </Scenario>",
      '  <Scenario id="hidden-regression" render={false} reason="Regression coverage">',
      '    <Step name="hidden-run">',
      '      <Run command="status" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    expect(lintGuideTranscripts(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic)).toEqual([]);
  });

  test("passes transcript lint when a clean guide declares diataxis", () => {
    const sourcePath = "core/test/lint/guides/transcript-diataxis.mdx";
    const content = [
      "---",
      "id: transcript-diataxis",
      "provider: test",
      "diataxis: tutorial",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="run">',
      '      <Run command="version" />',
      "    </Step>",
      "  </Scenario>",
      '  <Scenario id="hidden-regression" render={false} reason="Regression coverage">',
      '    <Step name="hidden-run">',
      '      <Run command="status" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    expect(lintGuideTranscripts(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic)).toEqual([]);
  });

  test("ignores @source and @step patterns inside library Run embedded code", () => {
    const sourcePath = "core/test/lint/guides/lib-embed-source.mdx";
    const content = [
      "---",
      "id: lib-embed-source",
      "provider: test",
      "diataxis: tutorial",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="library">',
      '      <Run runtime="library" code={`// @source: fake.mdx:1\\n// @step: evil\\nexpect(1).toBe(1);`} displayCode={`ok`} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    expect(lintGuideTranscripts(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic)).toEqual([]);
  });

  test("ignores @source inside library Run code that contains block-closing braces", () => {
    const sourcePath = "core/test/lint/guides/lib-embed-braces.mdx";
    const content = [
      "---",
      "id: lib-embed-braces",
      "provider: test",
      "diataxis: tutorial",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="library">',
      '      <Run runtime="library" code={`if (true) {\\n// @source: fake.mdx:9\\n}\\n`} displayCode={`ok`} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    expect(lintGuideTranscripts(sourcePath, content).diagnostics.map(formatGuideLintDiagnostic)).toEqual([]);
  });

  test("reports mixed runtime transcript build failures without throwing", () => {
    const sourcePath = "core/test/lint/guides/transcript-mixed-runtime.mdx";
    const content = [
      "---",
      "id: transcript-mixed-runtime",
      "provider: test",
      "diataxis: tutorial",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="reader-path">',
      '    <Step name="cli">',
      '      <Run command="version" />',
      "    </Step>",
      '    <Step name="library">',
      '      <Run runtime="library" code={`expect(1).toBe(1);`} displayCode={`expect(1).toBe(1);`} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");

    expect(lintGuideContent(sourcePath, content).diagnostics).toMatchObject([
      { code: "guide.runtime.mixed", scenario: "reader-path", line: 13 },
    ]);
    const diagnostics = lintGuideTranscripts(sourcePath, content).diagnostics;

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics).toMatchObject([{ code: "guide.runtime.mixed", scenario: "reader-path", line: 13 }]);
  });
});
