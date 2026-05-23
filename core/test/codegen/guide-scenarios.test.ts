import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { GuideFrontmatterValidationError, NotImplementedError } from "@lando/core/errors";
import {
  buildGuideScenarioAst,
  buildGuideScenarioTests,
  discoverGuideMdxFiles,
  emitGuideScenarioTests,
  parseGuideScenarioAst,
} from "../../../scripts/build-guide-scenarios.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "core/test/codegen/fixtures/guides");

const fixture = async (name: string): Promise<string> => readFile(resolve(fixturesRoot, name), "utf8");

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

  test("Beta-only frontmatter exits through the schema-level remediation", async () => {
    const content = await fixture("beta-only/beta.mdx");
    expect(() => parseGuideScenarioAst("docs/guides/beta-only/beta.mdx", content)).toThrow(
      NotImplementedError,
    );

    try {
      parseGuideScenarioAst("docs/guides/beta-only/beta.mdx", content);
    } catch (error) {
      expect(error instanceof NotImplementedError ? error.remediation : "").toContain("§19.16");
      expect(error instanceof NotImplementedError ? error.remediation : "").toContain("Phase 3 Beta");
    }
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

  test("emits deterministic Alpha 2 TypeScript scenario tests", async () => {
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
      expect(firstContent).toContain(
        'withScenarioContext({ guideId: "node-postgres", scenarioId: "start-app" }',
      );
      expect(firstContent).toContain("// @display: appName = Node/Postgres");
      expect(firstContent).toContain(
        'context.vars.set("appName", { value: "node-postgres", display: "Node/Postgres" });',
      );
      expect(firstContent).toContain("yield* Effect.addFinalizer(() => Effect.void);");
      expect(firstContent).toContain('yield* context.fixtures.use("basic-app");');
      expect(firstContent).toContain('context.runCli("version", {');
      expect(firstContent).toContain('context.events.find((event) => event._tag === "post-start")');

      const hiddenContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/multi-guide/hidden-regression.test.ts"),
      ).text();
      expect(hiddenContent).toContain('const verifyRun = yield* context.runCli("status");');
      const readerContent = await Bun.file(
        join(root, "test/scenarios/generated/guides/multi-guide/reader-path.test.ts"),
      ).text();
      expect(readerContent).toContain(
        'expect(((lastFailure ?? lastRun) as { _tag?: string })?._tag).toBe("None");',
      );
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
});
