import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(import.meta.dirname, "reporter");
const wrapperPath = resolve(repoRoot, "scripts/test-reporters/run-guide-scenarios.ts");

const fixtureNames = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
    .map((entry) => entry.name)
    .sort();

describe("scenario source-mapper reporter", async () => {
  for (const name of await fixtureNames()) {
    test(`rewrites ${name} fixture output`, async () => {
      const input = (await readFile(resolve(fixturesRoot, name, "input.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );
      const expected = (await readFile(resolve(fixturesRoot, name, "expected.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );

      expect(rewriteScenarioSourceMappedOutput(input, { repoRoot })).toBe(expected);
    });
  }

  test("can be disabled for raw bun test output", async () => {
    const input = (await readFile(resolve(fixturesRoot, "single-frame", "input.txt"), "utf8")).replaceAll(
      "<repo>",
      repoRoot,
    );

    expect(rewriteScenarioSourceMappedOutput(input, { repoRoot, disabled: true })).toBe(input);
  });

  test("keeps the re-run command as the failure block's last line", async () => {
    const input = (await readFile(resolve(fixturesRoot, "single-frame", "input.txt"), "utf8")).replaceAll(
      "<repo>",
      repoRoot,
    );

    const output = rewriteScenarioSourceMappedOutput(input, { repoRoot });
    const failureBlock = output.split("\n\n").find((block) => block.includes("(fail) source-map-guide:runs"));

    expect(failureBlock?.split("\n").at(-1)).toBe(
      "Re-run: bun run docs:scenario source-map-guide --scenario runs",
    );
  });

  test("adds escaped GitHub Actions annotations for mapped failures only in GitHub Actions", async () => {
    const GITHUB_ACTIONS_ENV = "GITHUB_ACTIONS";
    const previousGithubActions = process.env.GITHUB_ACTIONS;
    const tempRoot = await mkdtemp(join(tmpdir(), "lando-guide-reporter-"));
    const generatedPath = resolve(tempRoot, "test/scenarios/generated/guides/guide%id/scenario.fixture.ts");

    try {
      await mkdir(resolve(generatedPath, ".."), { recursive: true });
      await writeFile(
        generatedPath,
        [
          "// @generated",
          "// @source: docs/guides/source:map%,guide.mdx:7",
          "// @scenario: scenario:one%",
          "",
          'import { test } from "bun:test";',
          'import { withScenarioContext } from "@lando/core/testing";',
          "",
          'test("guide%id:scenario:one%", () => {',
          '  withScenarioContext({ guideId: "guide%id", scenarioId: "scenario:one%" }, () => {',
          "    // @source: docs/guides/source:map%,guide.mdx:42",
          '    throw new Error("seeded");',
          "  });",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      const input = [
        "bun test v1.3.14 (0d9b296a)",
        "",
        "test/scenarios/generated/guides/guide%id/scenario.fixture.ts:",
        "(FiberFailure) Error: first line%: detail",
        "second line",
        "      at toBe (unknown:1:1)",
        `      at ${generatedPath}:11:13`,
        `      at ${generatedPath}:11:13`,
        "(fail) guide%id:scenario:one% [12.00ms]",
        "",
        " 0 pass",
        " 1 fail",
      ].join("\n");

      process.env.GITHUB_ACTIONS = "true";
      const output = rewriteScenarioSourceMappedOutput(input, { repoRoot: tempRoot });
      const annotationLines = output.split("\n").filter((line) => line.startsWith("::error "));

      expect(annotationLines).toEqual([
        "::error file=docs/guides/source%3Amap%25%2Cguide.mdx,line=42,title=guide%25id%3Ascenario%3Aone%25::(FiberFailure) Error: first line%25: detail%0Asecond line",
      ]);
      expect(output).toContain("[guide%id:scenario:one%] (FiberFailure) Error: first line%: detail");
      expect(output).toContain("      at docs/guides/source:map%,guide.mdx:42");

      process.env.GITHUB_ACTIONS = "false";
      expect(rewriteScenarioSourceMappedOutput(input, { repoRoot: tempRoot })).not.toContain("::error ");
    } finally {
      if (previousGithubActions === undefined) delete process.env[GITHUB_ACTIONS_ENV];
      else process.env.GITHUB_ACTIONS = previousGithubActions;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("wrapper preserves bun test child exit codes", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lando-guide-runner-"));
    const passingTest = join(tempRoot, "passing.test.ts");
    const failingTest = join(tempRoot, "failing.test.ts");

    try {
      await writeFile(
        passingTest,
        ['import { expect, test } from "bun:test";', 'test("passes", () => expect(1).toBe(1));'].join("\n"),
        "utf8",
      );
      await writeFile(
        failingTest,
        ['import { expect, test } from "bun:test";', 'test("fails", () => expect(1).toBe(2));'].join("\n"),
        "utf8",
      );

      const runWrapper = async (testPath: string): Promise<number> => {
        const proc = Bun.spawn({
          cmd: [process.execPath, "run", wrapperPath, testPath],
          cwd: repoRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        return proc.exited;
      };

      expect(await runWrapper(passingTest)).toBe(0);
      expect(await runWrapper(failingTest)).not.toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
