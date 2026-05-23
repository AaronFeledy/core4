import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { GuideFrontmatterValidationError, NotImplementedError } from "@lando/core/errors";
import {
  buildGuideScenarioAst,
  discoverGuideMdxFiles,
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
});
