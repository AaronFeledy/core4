import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { GuideFrontmatterValidationError, GuideHiddenScenarioReasonError } from "@lando/core/errors";
import {
  buildGuideScenarioAst,
  buildGuideScenarioTests,
  discoverGuideMdxFiles,
  emitGuideScenarioTests,
  parseGuideScenarioAst,
  resolveHostGuidePlatform,
} from "../../../scripts/build-guide-scenarios.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "core/test/codegen/fixtures/guides");

const fixture = async (name: string): Promise<string> => readFile(resolve(fixturesRoot, name), "utf8");

const linkNodeModules = async (root: string): Promise<void> => {
  await symlink(resolve(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
};

const GUIDE_SCENARIO_PLATFORM_ENV = "LANDO_GUIDE_SCENARIO_PLATFORM";
const withGuideScenarioPlatform = async <T>(
  platform: string | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = process.env[GUIDE_SCENARIO_PLATFORM_ENV];
  try {
    if (platform === undefined) {
      delete process.env[GUIDE_SCENARIO_PLATFORM_ENV];
    } else {
      process.env[GUIDE_SCENARIO_PLATFORM_ENV] = platform;
    }
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[GUIDE_SCENARIO_PLATFORM_ENV];
    } else {
      process.env[GUIDE_SCENARIO_PLATFORM_ENV] = previous;
    }
  }
};

describe("build-guide-scenarios MDX walker", () => {
  test("discovers docs guides and recipe README MDX files deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-walker-"));
    try {
      await mkdir(join(root, "docs/guides/nested"), { recursive: true });
      await mkdir(join(root, "recipes/sample"), { recursive: true });
      await Bun.write(join(root, "docs/guides/b.mdx"), "---\nid: b\n---\n\n<Guide />\n");
      await Bun.write(join(root, "docs/guides/nested/a.mdx"), "---\nid: a\n---\n\n<Guide />\n");
      await Bun.write(join(root, "recipes/sample/README.mdx"), "---\nid: sample\n---\n\n<Guide />\n");

      expect(await discoverGuideMdxFiles(root)).toEqual([
        "docs/guides/b.mdx",
        "docs/guides/nested/a.mdx",
        "recipes/sample/README.mdx",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("missing docs guides is not an error and produces no AST entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-empty-"));
    try {
      expect(await discoverGuideMdxFiles(root)).toEqual([]);
      expect(await buildGuideScenarioAst(root)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("flattens happy-path and hidden scenarios into a deterministic AST", async () => {
    const first = [
      parseGuideScenarioAst(
        "docs/guides/happy-path/node-postgres.mdx",
        await fixture("happy-path/node-postgres.mdx"),
      ),
      parseGuideScenarioAst(
        "docs/guides/multi-scenario/multi.mdx",
        await fixture("multi-scenario/multi.mdx"),
      ),
    ];
    const second = [
      parseGuideScenarioAst(
        "docs/guides/happy-path/node-postgres.mdx",
        await fixture("happy-path/node-postgres.mdx"),
      ),
      parseGuideScenarioAst(
        "docs/guides/multi-scenario/multi.mdx",
        await fixture("multi-scenario/multi.mdx"),
      ),
    ];

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map((guide) => guide.sourcePath)).toEqual([
      "docs/guides/happy-path/node-postgres.mdx",
      "docs/guides/multi-scenario/multi.mdx",
    ]);

    const happy = first[0];
    expect(happy?.frontmatter).toMatchObject({ id: "node-postgres", provider: "test", timeout: 60000 });
    expect(happy?.scenarios[0]).toMatchObject({ id: "start-app", render: true });
    expect(
      happy?.scenarios[0]?.steps.map((step) => [
        step.stepName,
        step.components.map((component) => component.kind),
      ]),
    ).toEqual([
      ["configure", ["Variable", "UseFixture"]],
      ["run", ["Run", "Verify", "Cleanup"]],
    ]);

    const multi = first[1];
    expect(multi?.scenarios.map((scenario) => [scenario.id, scenario.render])).toEqual([
      ["hidden-regression", false],
      ["reader-path", true],
    ]);
  });

  test("e2e default layer parses through guide frontmatter", async () => {
    const content = await fixture("beta-only/beta.mdx");
    const ast = parseGuideScenarioAst("docs/guides/beta-only/beta.mdx", content);
    expect(ast.frontmatter.defaultLayer).toBe("e2e");
  });

  test("invalid frontmatter raises a tagged validation error with field and rejected value", () => {
    const content = "---\nid: Bad\n---\n\n<Guide />\n";
    expect(() => parseGuideScenarioAst("docs/guides/bad.mdx", content)).toThrow(
      GuideFrontmatterValidationError,
    );
    try {
      parseGuideScenarioAst("docs/guides/bad.mdx", content);
    } catch (error) {
      expect(error instanceof GuideFrontmatterValidationError ? error.field : "").toBe("id");
      expect(error instanceof GuideFrontmatterValidationError ? error.rejectedValue : undefined).toBe("Bad");
    }
  });

  test("emits deterministic generated TypeScript scenario tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-ts-"));
    try {
      const asts = [
        parseGuideScenarioAst(
          "docs/guides/happy-path/node-postgres.mdx",
          await fixture("happy-path/node-postgres.mdx"),
        ),
        parseGuideScenarioAst(
          "docs/guides/multi-scenario/multi.mdx",
          await fixture("multi-scenario/multi.mdx"),
        ),
      ];

      const first = await emitGuideScenarioTests(asts, root);
      const firstContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/node-postgres/start-app.test.ts"),
      ).text();
      const second = await emitGuideScenarioTests(asts, root);
      const secondContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/node-postgres/start-app.test.ts"),
      ).text();

      expect(second).toEqual(first);
      expect(secondContent).toBe(firstContent);
      expect(first).toEqual([
        "test/scenarios/generated/guides/multi-guide/hidden-regression.test.ts",
        "test/scenarios/generated/guides/multi-guide/reader-path.test.ts",
        "test/scenarios/generated/guides/node-postgres/start-app.test.ts",
      ]);
      expect(firstContent).toStartWith(
        "// @generated\n// @source: docs/guides/happy-path/node-postgres.mdx:9\n// @scenario: start-app\n// @variant:",
      );
      expect(firstContent).toContain('import { withScenarioContext } from "@lando/core/testing";');
      expect(firstContent).not.toContain('import * as LandoCore from "@lando/core";');
      expect(firstContent).not.toContain('import * as LandoTesting from "@lando/core/testing";');
      expect(firstContent).toContain(
        'withScenarioContext({ guideId: "node-postgres", scenarioId: "start-app", render: true }',
      );
      expect(firstContent).toContain('test("alpha2 docs node-postgres:start-app"');
      expect(firstContent).not.toContain('test("alpha2 docs node-postgres:start-app (');
      expect(firstContent).toContain("// @display: appName = Node/Postgres");
      expect(firstContent).toContain(
        'context.vars.set("appName", { value: "node-postgres", display: "Node/Postgres" });',
      );
      expect(firstContent).toContain(
        'yield* Effect.addFinalizer(() => context.transcript.append({ kind: "cleanup", command: [], exit: 0 }));',
      );
      expect(firstContent).toContain('yield* context.fixtures.use("basic-app");');
      expect(firstContent).toContain('context.runCli("version", {');
      expect(firstContent).toContain('context.events.find((event) => event._tag === "post-start")');
      expect(firstContent).toContain('yield* context.transcript.append({ kind: "verify", target: "event"');

      const hiddenContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/multi-guide/hidden-regression.test.ts"),
      ).text();
      expect(hiddenContent).toStartWith(
        "// @generated\n// @source: docs/guides/multi-scenario/multi.mdx:13\n// @scenario: hidden-regression\n// @render: false\n// @variant:",
      );
      expect(hiddenContent).toContain('const verifyRun = yield* context.runCli("status");');
      const readerContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/multi-guide/reader-path.test.ts"),
      ).text();
      expect(readerContent).not.toContain("// @render: false");
      expect(readerContent).toContain("const failureForErrorTag = lastFailure ?? lastRun;");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits gated e2e smoke scenario tests from MDX while preserving source headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-e2e-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/e2e-smoke.mdx"),
        [
          "---",
          "id: e2e-smoke",
          "provider: test",
          "defaultLayer: e2e",
          'tags: ["@smoke"]',
          "---",
          "",
          "<Guide>",
          '  <Scenario id="provider-path" render>',
          '    <Step name="version">',
          '      <Run command="version" />',
          '      <Verify command="version" expect={{ regex: "[0-9]+" }} />',
          "    </Step>",
          '    <Step name="teardown">',
          "      <Cleanup />",
          '      <Run command="destroy -y" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      const written = await emitGuideScenarioTests(asts, root);
      const content = await Bun.file(
        join(root, "test/scenarios/generated/guides/e2e-smoke/provider-path.test.ts"),
      ).text();

      expect(written).toEqual(["test/scenarios/generated/guides/e2e-smoke/provider-path.test.ts"]);
      expect(content).toStartWith(
        "// @generated\n// @source: docs/guides/e2e-smoke.mdx:9\n// @scenario: provider-path\n// @variant:\n// @tags: @smoke\n// @layer: e2e",
      );
      expect(content).toContain('import { ScenarioContextFactory } from "@lando/core/testing";');
      expect(content).toContain(
        'const e2eGateEnabled = process.env.LANDO_GUIDE_E2E === "1" && process.env.LANDO_SCENARIO_E2E_BINARY !== undefined;',
      );
      expect(content).toContain(
        '(e2eGateEnabled ? test : test.skip)((e2eGateEnabled ? "@smoke e2e-smoke:provider-path [e2e]"',
      );
      expect(content).toContain(
        '"@smoke e2e-smoke:provider-path [e2e] (skipped: set LANDO_GUIDE_E2E=1 and LANDO_SCENARIO_E2E_BINARY to run e2e guide scenarios)"',
      );
      expect(content).toContain(
        'ScenarioContextFactory.e2e({ guideId: "e2e-smoke", scenarioId: "provider-path", render: true }',
      );
      expect(content).toContain("// @source: docs/guides/e2e-smoke.mdx:11");
      expect(content).toContain("// @source: docs/guides/e2e-smoke.mdx:15");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("e2e tests carry the frontmatter timeout and force skip for skipped variants", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-e2e-skip-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/e2e-variant.mdx"),
        [
          "---",
          "id: e2e-variant",
          "provider: test",
          "defaultLayer: e2e",
          "timeout: 120000",
          "tabs: [alpha, beta]",
          "variants:",
          "  alpha:",
          "    skip:",
          "      reason: not ready yet",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="provider-path" render>',
          '    <Step name="version">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      await emitGuideScenarioTests(asts, root);
      const dir = join(root, "test/scenarios/generated/guides/e2e-variant");
      const skipped = await Bun.file(join(dir, "provider-path.alpha.test.ts")).text();
      const gated = await Bun.file(join(dir, "provider-path.beta.test.ts")).text();

      expect(skipped).toContain("test.skip(");
      expect(skipped).not.toContain("e2eGateEnabled ? test : test.skip");
      expect(gated).toContain("(e2eGateEnabled ? test : test.skip)");
      expect(skipped).toContain("}, 120000);");
      expect(gated).toContain("}, 120000);");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("variant labels preserve leading smoke tags and trailing e2e marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-e2e-variant-title-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/e2e-variant-title.mdx"),
        [
          "---",
          "id: e2e-variant-title",
          "provider: test",
          "defaultLayer: e2e",
          'tags: ["@smoke"]',
          "tabs: [linux]",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="provider-path" render>',
          '    <Step name="version">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const asts = await buildGuideScenarioAst(root);
      await emitGuideScenarioTests(asts, root);
      const content = await Bun.file(
        join(root, "test/scenarios/generated/guides/e2e-variant-title/provider-path.linux.test.ts"),
      ).text();
      const labeledTitle = "@smoke e2e-variant-title:provider-path (default=linux) [e2e]";

      expect(content).toContain(`"${labeledTitle}"`);
      expect(labeledTitle).toMatch(/@smoke.*\[e2e\]/);
      expect(labeledTitle.endsWith(" [e2e]")).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("resolves the guide scenario host platform from override, WSL env, and process platform", () => {
    expect(resolveHostGuidePlatform({ LANDO_GUIDE_SCENARIO_PLATFORM: "darwin" })).toBe("darwin");
    expect(
      resolveHostGuidePlatform({ LANDO_GUIDE_SCENARIO_PLATFORM: "wsl", WSL_DISTRO_NAME: "Ubuntu" }),
    ).toBe("wsl");
    expect(resolveHostGuidePlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe("wsl");
    expect(resolveHostGuidePlatform({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux")).toBe("wsl");
    expect(resolveHostGuidePlatform({}, "win32")).toBe("win32");
    expect(resolveHostGuidePlatform({}, "darwin")).toBe("darwin");
    expect(resolveHostGuidePlatform({}, "freebsd")).toBe("linux");
  });

  test("emits platform-excluded scenario tests as skipped with a visible reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-platform-skip-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      const content = [
        "---",
        "id: platform-guide",
        "provider: test",
        "platforms: [linux, darwin]",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="main">',
        '    <Step name="run">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");

      await withGuideScenarioPlatform("win32", async () => {
        const asts = [parseGuideScenarioAst("docs/guides/platform-guide.mdx", content)];
        await emitGuideScenarioTests(asts, root);
      });

      const generated = await Bun.file(
        join(root, "test/scenarios/generated/guides/platform-guide/main.test.ts"),
      ).text();
      expect(generated).toContain("// @platforms: linux,darwin");
      expect(generated).toContain(
        'test.skip("platform-guide:main (skipped on win32: requires platform [linux,darwin])"',
      );
      expect(generated).not.toContain("(e2eGateEnabled ? test : test.skip)");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits normal scenario tests when the host is allowed or platforms is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-platform-allowed-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      const allowed = [
        "---",
        "id: allowed-guide",
        "provider: test",
        "platforms: [linux, darwin]",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="main">',
        '    <Step name="run">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");
      const empty = [
        "---",
        "id: empty-platform-guide",
        "provider: test",
        "platforms: []",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="main">',
        '    <Step name="run">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");

      await withGuideScenarioPlatform("linux", async () => {
        const asts = [
          parseGuideScenarioAst("docs/guides/allowed-guide.mdx", allowed),
          parseGuideScenarioAst("docs/guides/empty-platform-guide.mdx", empty),
        ];
        await emitGuideScenarioTests(asts, root);
      });

      const allowedGenerated = await Bun.file(
        join(root, "test/scenarios/generated/guides/allowed-guide/main.test.ts"),
      ).text();
      const emptyGenerated = await Bun.file(
        join(root, "test/scenarios/generated/guides/empty-platform-guide/main.test.ts"),
      ).text();
      expect(allowedGenerated).toContain('test("allowed-guide:main"');
      expect(allowedGenerated).not.toContain("skipped on linux");
      expect(emptyGenerated).toContain('test("empty-platform-guide:main"');
      expect(emptyGenerated).not.toContain("requires platform");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a WSL host runs linux-allow-listed guides but skips windows-only guides", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-platform-wsl-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      const makeGuide = (id: string, platforms: string): string =>
        [
          "---",
          `id: ${id}`,
          "provider: test",
          `platforms: ${platforms}`,
          "---",
          "",
          "<Guide>",
          '  <Scenario id="main">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n");
      const linuxGuide = makeGuide("wsl-linux-guide", "[darwin, linux, win32]");
      const windowsGuide = makeGuide("wsl-windows-guide", "[win32]");

      await withGuideScenarioPlatform("wsl", async () => {
        await emitGuideScenarioTests(
          [
            parseGuideScenarioAst("docs/guides/wsl-linux-guide.mdx", linuxGuide),
            parseGuideScenarioAst("docs/guides/wsl-windows-guide.mdx", windowsGuide),
          ],
          root,
        );
      });

      const linuxGenerated = await Bun.file(
        join(root, "test/scenarios/generated/guides/wsl-linux-guide/main.test.ts"),
      ).text();
      const windowsGenerated = await Bun.file(
        join(root, "test/scenarios/generated/guides/wsl-windows-guide/main.test.ts"),
      ).text();

      expect(linuxGenerated).toContain('test("wsl-linux-guide:main"');
      expect(linuxGenerated).not.toContain("skipped on wsl");
      expect(windowsGenerated).toContain(
        'test.skip("wsl-windows-guide:main (skipped on wsl: requires platform [win32])"',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("variant platforms override guide platforms for generation-time platform skips", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-platform-variant-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      const content = [
        "---",
        "id: variant-platform-guide",
        "provider: test",
        "platforms: [linux]",
        "tabs: [alpha, beta]",
        "variants:",
        "  beta:",
        "    platforms: [win32]",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="main">',
        '    <Step name="run">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");

      await withGuideScenarioPlatform("win32", async () => {
        const asts = [parseGuideScenarioAst("docs/guides/variant-platform-guide.mdx", content)];
        await emitGuideScenarioTests(asts, root);
      });

      const alpha = await Bun.file(
        join(root, "test/scenarios/generated/guides/variant-platform-guide/main.alpha.test.ts"),
      ).text();
      const beta = await Bun.file(
        join(root, "test/scenarios/generated/guides/variant-platform-guide/main.beta.test.ts"),
      ).text();
      expect(alpha).toContain(
        'test.skip("variant-platform-guide:main (default=alpha) (skipped on win32: requires platform [linux])"',
      );
      expect(alpha).toContain("// @platforms: linux");
      expect(beta).toContain('test("variant-platform-guide:main (default=beta)"');
      expect(beta).toContain("// @platforms: win32");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("clears stale generated guide tests before writing current scenarios", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-clear-"));
    try {
      const stalePath = join(root, "test/scenarios/generated/guides/stale/old.test.ts");
      await mkdir(join(root, "test/scenarios/generated/guides/stale"), { recursive: true });
      await Bun.write(stalePath, "stale");

      const asts = [
        parseGuideScenarioAst(
          "docs/guides/happy-path/node-postgres.mdx",
          await fixture("happy-path/node-postgres.mdx"),
        ),
      ];
      const written = await emitGuideScenarioTests(asts, root);

      expect(written).toEqual(["test/scenarios/generated/guides/node-postgres/start-app.test.ts"]);
      expect(await Bun.file(stalePath).exists()).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("renders Run expectExit when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-exit-"));
    try {
      const content = [
        "---",
        "id: exit-case",
        "provider: test",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="nonzero-exit">',
        '    <Step name="run">',
        '      <Run command="version" expectExit={1} />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");
      await mkdir(join(root, "docs/guides/exit-case"), { recursive: true });
      await Bun.write(join(root, "docs/guides/exit-case/exit-case.mdx"), content);

      const asts = [parseGuideScenarioAst("docs/guides/exit-case/exit-case.mdx", content)];
      await emitGuideScenarioTests(asts, root);
      const generated = await Bun.file(
        join(root, "test/scenarios/generated/guides/exit-case/nonzero-exit.test.ts"),
      ).text();
      expect(generated).toContain("expect(runAttempt.right.exitCode).toBe(1);");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("renders array matchers as structural comparisons", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-array-"));
    try {
      const content = [
        "---",
        "id: array-case",
        "provider: test",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="array-match">',
        '    <Step name="verify">',
        '      <Verify command="version" expect={ ["0.0.0\\n"] } />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");
      await mkdir(join(root, "docs/guides/array-case"), { recursive: true });
      await Bun.write(join(root, "docs/guides/array-case/array-case.mdx"), content);

      const asts = [parseGuideScenarioAst("docs/guides/array-case/array-case.mdx", content)];
      await emitGuideScenarioTests(asts, root);
      const generated = await Bun.file(
        join(root, "test/scenarios/generated/guides/array-case/array-match.test.ts"),
      ).text();
      expect(generated).toContain("Array.isArray(actual) && expected.length === actual.length");
      expect(generated).toContain("expected.every((value, index) => matchesExpected(actual[index], value))");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits ctx.inspect calls for <Inspect> and runs against ScenarioContext", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-inspect-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/inspect.mdx"),
        [
          "---",
          "id: inspect-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="inspect-state">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "      <Inspect output />",
          "      <Inspect events />",
          '      <Inspect file="notes.txt" />',
          '      <Inspect json="config.json" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/inspect-guide/inspect-state.test.ts"]);
      const generated = await Bun.file(join(root, written[0] ?? "")).text();
      expect(generated).toContain("yield* context.inspect({ output: true });");
      expect(generated).toContain("yield* context.inspect({ events: true });");
      expect(generated).toContain('yield* context.inspect({ file: "notes.txt" });');
      expect(generated).toContain('yield* context.inspect({ json: "config.json" });');

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits a suppressed context.hidden block for <Hidden> and runs against ScenarioContext", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-hidden-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/hidden.mdx"),
        [
          "---",
          "id: hidden-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="seeded">',
          '    <Hidden reason="seed deterministic state invisibly">',
          '      <Step name="seed">',
          '        <Run command="version" />',
          "      </Step>",
          "    </Hidden>",
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/hidden-guide/seeded.test.ts"]);
      const generated = await Bun.file(join(root, written[0] ?? "")).text();
      expect(generated).toContain("// @hidden: seed deterministic state invisibly");
      expect(generated).toContain("yield* context.hidden(Effect.gen(function* () {");
      expect(generated).toContain("// @step: seed");
      expect(generated).toContain("// @step: run");

      const ast = parseGuideScenarioAst(
        "docs/guides/hidden.mdx",
        await Bun.file(join(root, "docs/guides/hidden.mdx")).text(),
      );
      expect(ast.scenarios[0]?.body.map((item) => item.kind)).toEqual(["hidden", "step"]);

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("suppresses cleanup frames for <Cleanup> authored inside <Hidden>", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-hidden-cleanup-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/hidden-cleanup.mdx"),
        [
          "---",
          "id: hidden-cleanup-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="seeded">',
          '    <Hidden reason="seed deterministic state invisibly">',
          '      <Step name="seed">',
          '        <Run command="version" />',
          "        <Cleanup />",
          "      </Step>",
          "    </Hidden>",
          '    <Step name="run">',
          '      <Run command="version" />',
          "      <Cleanup />",
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/hidden-cleanup-guide/seeded.test.ts"]);
      const generated = await Bun.file(join(root, written[0] ?? "")).text();
      expect(generated).toContain(
        'yield* Effect.addFinalizer(() => context.hidden(context.transcript.append({ kind: "cleanup", command: [], exit: 0 })));',
      );
      expect(generated).toContain(
        'yield* Effect.addFinalizer(() => context.transcript.append({ kind: "cleanup", command: [], exit: 0 }));',
      );

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("generated scenario TypeScript runs against ScenarioContext", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-run-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/smoke.mdx"),
        [
          "---",
          "id: smoke-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="version-check">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/smoke-guide/version-check.test.ts"]);
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits a verbatim inline transcript frame for <Inline> with no execution code", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-inline-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/inline.mdx"),
        [
          "---",
          "id: inline-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="sample">',
          '    <Step name="run">',
          '      <Run command="version" />',
          '      <Inline code="const config = { api: 4 };" justification="shows the config object" />',
          '      <Inline code="print(1)" lang="py" justification="python sample only" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/inline-guide/sample.test.ts"]);
      const generated = await Bun.file(join(root, written[0] ?? "")).text();
      expect(generated).toContain(
        'yield* context.transcript.append({ kind: "inline", lang: "ts", code: "const config = { api: 4 };" });',
      );
      expect(generated).toContain(
        'yield* context.transcript.append({ kind: "inline", lang: "py", code: "print(1)" });',
      );
      expect(generated).not.toContain('context.runCli("const config');
      expect(generated).not.toContain('context.shell("const config');

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits test.skip for steps inside <Skip> and keeps them out of the main test", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-skip-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/skip.mdx"),
        [
          "---",
          "id: skip-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="partial">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          '    <Skip reason="awaiting upstream fix">',
          '      <Step name="later">',
          '        <Run command="version" />',
          "      </Step>",
          "    </Skip>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/skip-guide/partial.test.ts"]);
      const generated = await Bun.file(join(root, written[0] ?? "")).text();
      expect(generated).toContain("// @skip: awaiting upstream fix");
      expect(generated).toContain('test.skip("later", () => {});');
      expect(generated).not.toContain("// @step: later");

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", join(root, written[0] ?? "")],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("test-only scenarios require a reason", () => {
    const missingReason = [
      "---",
      "id: hidden-case",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="missing-reason" render={false}>',
      '    <Step name="run">',
      '      <Run command="version" />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");
    const shortReason = missingReason.replace(
      'id="missing-reason" render={false}',
      'id="short-reason" render={false} reason="short"',
    );

    for (const content of [missingReason, shortReason]) {
      expect(() => parseGuideScenarioAst("docs/guides/hidden-case.mdx", content)).toThrow(
        GuideHiddenScenarioReasonError,
      );
      try {
        parseGuideScenarioAst("docs/guides/hidden-case.mdx", content);
      } catch (error) {
        expect(error instanceof GuideHiddenScenarioReasonError ? error.remediation : "").toContain(
          "at least 8 characters",
        );
        expect(error instanceof GuideHiddenScenarioReasonError ? error.commandId : "").toBe(
          "guide.scenario.hidden-reason",
        );
      }
    }
  });

  test("fans out single-axis tabs into per-variant files with coverage-gap skips", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-tabs-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/tabs.mdx"),
        [
          "---",
          "id: tabs-guide",
          "provider: test",
          "tabs: [linux, macos]",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="main">',
          '    <Step name="prepare">',
          '      <Run command="version" />',
          "    </Step>",
          "    <Tabs>",
          '      <Tab name="linux">',
          '        <Step name="install">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          '      <Tab name="macos">',
          '        <Step name="install">',
          '          <Run command="version" />',
          "        </Step>",
          '        <Step name="brew">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          "    </Tabs>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual([
        "test/scenarios/generated/guides/tabs-guide/main.linux.test.ts",
        "test/scenarios/generated/guides/tabs-guide/main.macos.test.ts",
      ]);

      const linux = await Bun.file(
        join(root, "test/scenarios/generated/guides/tabs-guide/main.linux.test.ts"),
      ).text();
      const macos = await Bun.file(
        join(root, "test/scenarios/generated/guides/tabs-guide/main.macos.test.ts"),
      ).text();

      expect(linux).toContain("// @variant: default=linux");
      expect(macos).toContain("// @variant: default=macos");
      expect(linux).toContain("// @step: prepare");
      expect(macos).toContain("// @step: prepare");
      expect(linux).toContain("// @step: install");
      expect(macos).toContain("// @step: install");
      expect(macos).toContain("// @step: brew");
      expect(linux).not.toContain("// @step: brew");
      expect(linux).toContain('test.skip("brew", () => {');
      expect(linux).toContain("axis default=linux tab does not include step brew");
      expect(macos).not.toContain("test.skip(");

      const second = await buildGuideScenarioTests(root);
      expect(second).toEqual(written);
      const linuxAgain = await Bun.file(
        join(root, "test/scenarios/generated/guides/tabs-guide/main.linux.test.ts"),
      ).text();
      expect(linuxAgain).toBe(linux);

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", ...written.map((path) => join(root, path))],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fans out multi-axis `axes:` into the Cartesian product with per-cell overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-axes-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/matrix.mdx"),
        [
          "---",
          "id: matrix-guide",
          "provider: test",
          "axes:",
          "  os: [linux, macos]",
          "  package-manager: [composer, npm]",
          "variants:",
          "  linux.npm:",
          "    skip:",
          "      reason: npm on linux not covered here",
          "  macos.composer:",
          "    tags: [slow]",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="main">',
          '    <Step name="prepare">',
          '      <Run command="version" />',
          "    </Step>",
          '    <Tabs axis="os">',
          '      <Tab name="linux">',
          '        <Step name="os-step">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          '      <Tab name="macos">',
          '        <Step name="os-step">',
          '          <Run command="version" />',
          "        </Step>",
          '        <Step name="brew">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          "    </Tabs>",
          '    <Tabs axis="package-manager">',
          '      <Tab name="composer">',
          '        <Step name="pm-step">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          '      <Tab name="npm">',
          '        <Step name="pm-step">',
          '          <Run command="version" />',
          "        </Step>",
          "      </Tab>",
          "    </Tabs>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual([
        "test/scenarios/generated/guides/matrix-guide/main.linux.composer.test.ts",
        "test/scenarios/generated/guides/matrix-guide/main.linux.npm.test.ts",
        "test/scenarios/generated/guides/matrix-guide/main.macos.composer.test.ts",
        "test/scenarios/generated/guides/matrix-guide/main.macos.npm.test.ts",
      ]);

      const read = (relative: string): Promise<string> => Bun.file(join(root, relative)).text();
      const linuxComposer = await read(written[0] ?? "");
      const linuxNpm = await read(written[1] ?? "");
      const macosComposer = await read(written[2] ?? "");
      const macosNpm = await read(written[3] ?? "");

      expect(linuxComposer).toContain("// @variant: os=linux package-manager=composer");
      expect(macosNpm).toContain("// @variant: os=macos package-manager=npm");
      expect(linuxComposer).toContain('test("matrix-guide:main (os=linux package-manager=composer)"');
      expect(macosNpm).toContain('test("matrix-guide:main (os=macos package-manager=npm)"');
      expect(linuxComposer).not.toContain('test("matrix-guide:main (os=macos package-manager=npm)"');

      expect(linuxComposer).toContain("// @step: prepare");
      expect(linuxComposer).toContain("// @step: os-step");
      expect(linuxComposer).toContain("// @step: pm-step");
      expect(linuxComposer).not.toContain("// @step: brew");
      expect(linuxComposer).toContain('test.skip("brew", () => {');
      expect(linuxComposer).toContain("axis os=linux tab does not include step brew");

      expect(macosComposer).toContain("// @step: brew");
      expect(macosComposer).toContain("// @tags: slow");
      expect(macosComposer).not.toContain("// @variant-skip:");

      expect(linuxNpm).toContain("// @variant-skip: npm on linux not covered here");
      expect(linuxNpm).toContain('test.skip("matrix-guide:main (os=linux package-manager=npm)"');
      expect(linuxNpm).not.toContain('test("matrix-guide:main (os=linux package-manager=npm)"');

      const second = await buildGuideScenarioTests(root);
      expect(second).toEqual(written);
      expect(await read(written[0] ?? "")).toBe(linuxComposer);

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", ...written.map((path) => join(root, path))],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("sorts variant title labels by axis name deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-title-sort-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      const content = [
        "---",
        "id: sorted-title-guide",
        "provider: test",
        "axes:",
        "  package-manager: [npm]",
        "  os: [linux]",
        "---",
        "",
        "<Guide>",
        '  <Scenario id="main">',
        '    <Step name="run">',
        '      <Run command="version" />',
        "    </Step>",
        "  </Scenario>",
        "</Guide>",
        "",
      ].join("\n");
      const asts = [parseGuideScenarioAst("docs/guides/sorted-title.mdx", content)];

      await emitGuideScenarioTests(asts, root);
      const generatedPath = join(
        root,
        "test/scenarios/generated/guides/sorted-title-guide/main.npm.linux.test.ts",
      );
      const first = await Bun.file(generatedPath).text();
      await emitGuideScenarioTests(asts, root);
      const second = await Bun.file(generatedPath).text();

      expect(first).toContain("// @variant: package-manager=npm os=linux");
      expect(first).toContain('test("sorted-title-guide:main (os=linux package-manager=npm)"');
      expect(second).toBe(first);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fans out tabless scenarios into identical variants under a tabbed guide", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-tabless-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/notabs.mdx"),
        [
          "---",
          "id: notabs-guide",
          "provider: test",
          "tabs: [linux, macos]",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="shared">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual([
        "test/scenarios/generated/guides/notabs-guide/shared.linux.test.ts",
        "test/scenarios/generated/guides/notabs-guide/shared.macos.test.ts",
      ]);

      const linux = await Bun.file(join(root, written[0] ?? "")).text();
      const macos = await Bun.file(join(root, written[1] ?? "")).text();
      const stripVariant = (content: string): string =>
        content
          .replace(/\/\/ @variant: default=\w+/g, "// @variant:")
          .replace(/notabs-guide:shared \(default=\w+\)/g, "notabs-guide:shared");
      expect(stripVariant(linux)).toBe(stripVariant(macos));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("mixed reader and test-only scenarios both generate runnable tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-mixed-"));
    try {
      await mkdir(join(root, "docs/guides"), { recursive: true });
      await Bun.write(
        join(root, "docs/guides/mixed.mdx"),
        [
          "---",
          "id: mixed-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="reader-path">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          '  <Scenario id="test-only-path" render={false} reason="Covers hidden behavior">',
          '    <Step name="run">',
          '      <Run command="version" />',
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual([
        "test/scenarios/generated/guides/mixed-guide/reader-path.test.ts",
        "test/scenarios/generated/guides/mixed-guide/test-only-path.test.ts",
      ]);
      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", ...written.map((path) => join(root, path))],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits and executes all-library scenario tests with library imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-library-"));
    try {
      const guidePath = "docs/guides/library-mode/library-mode.mdx";
      await mkdir(join(root, "docs/guides/library-mode"), { recursive: true });
      await Bun.write(
        join(root, guidePath),
        [
          "---",
          "id: library-mode-guide",
          "provider: test",
          "---",
          "",
          "<Guide>",
          '  <Scenario id="library-read">',
          '    <Step name="read-file">',
          "      <Run",
          '        runtime="library"',
          '        code={`context.runtime.files.set("/app/.lando.yml", "name: LIBRARY_MARKER\\n");',
          "const fileSystem = yield* LandoCore.FileSystem.pipe(Effect.provide(context.runtime.layer));",
          'const text = yield* fileSystem.readText("/app/.lando.yml");',
          'expect(text).toContain("LIBRARY_MARKER");`}',
          '        displayCode={`import { FileSystem } from "@lando/core";`}',
          "      />",
          "    </Step>",
          "  </Scenario>",
          "</Guide>",
          "",
        ].join("\n"),
      );

      await linkNodeModules(root);

      const written = await buildGuideScenarioTests(root);
      expect(written).toEqual(["test/scenarios/generated/guides/library-mode-guide/library-read.test.ts"]);
      const generatedPath = join(root, written[0] ?? "");
      const generated = await Bun.file(generatedPath).text();
      expect(generated).toContain('import * as LandoCore from "@lando/core";');
      expect(generated).toContain('import * as LandoTesting from "@lando/core/testing";');
      expect(generated).toContain("LandoTesting.withScenarioContext(");
      expect(generated).toContain("void LandoCore;");
      expect(generated).toContain("void LandoTesting;");
      expect(generated).toContain("LIBRARY_MARKER");
      expect(generated).toContain(
        'context.runtime.files.set("/app/.lando.yml", "name: LIBRARY_MARKER\\n");\n      const fileSystem = yield* LandoCore.FileSystem.pipe(Effect.provide(context.runtime.layer));\n      const text = yield* fileSystem.readText("/app/.lando.yml");\n      expect(text).toContain("LIBRARY_MARKER");',
      );
      expect(generated).not.toContain("context.runCli");
      expect(generated).not.toContain("context.shell(");
      expect(generated).toContain(`// @source: ${guidePath}:9`);

      const proc = Bun.spawnSync({
        cmd: [process.execPath, "test", generatedPath],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("accepts escaped template syntax in library backtick props", async () => {
    const content = [
      "---",
      "id: library-escaped-template-syntax",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="escaped">',
      '    <Step name="run">',
      '      <Run runtime="library" code={`expect("\\${LANDO_APP_NAME}").toBe("\\${LANDO_APP_NAME}");`} displayCode={`echo \\${LANDO_APP_NAME}`} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");

    const ast = parseGuideScenarioAst("docs/guides/library-escaped-template-syntax.mdx", content);
    expect(ast.scenarios[0]?.steps[0]?.components[0]).toMatchObject({
      kind: "Run",
      props: {
        runtime: "library",
        code: 'expect("\\${LANDO_APP_NAME}").toBe("\\${LANDO_APP_NAME}");',
        displayCode: "echo \\${LANDO_APP_NAME}",
      },
    });
  });

  test("rejects library template-literal prop interpolation", async () => {
    const content = [
      "---",
      "id: library-interpolation",
      "provider: test",
      "---",
      "",
      "<Guide>",
      '  <Scenario id="bad">',
      '    <Step name="run">',
      '      <Run runtime="library" code={`a${b}c`} displayCode={`x`} />',
      "    </Step>",
      "  </Scenario>",
      "</Guide>",
      "",
    ].join("\n");

    expect(() => parseGuideScenarioAst("docs/guides/library-interpolation.mdx", content)).toThrow(
      /interpolation|\$\{/i,
    );
  });
});
