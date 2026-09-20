// allow: SIZE_OK — Keep reporter contract fixtures and wrapper regressions together in one sharded suite; do not split.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  LIVE_OUTPUT_BANNER,
  LIVE_OUTPUT_ENV,
  MAPPED_OUTPUT_BANNER,
} from "../../../scripts/test-reporters/run-guide-scenarios.ts";
import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(import.meta.dirname, "reporter");
const wrapperPath = resolve(repoRoot, "scripts/test-reporters/run-guide-scenarios.ts");

const spawnWrapper = (testPath: string, live: boolean) => {
  const env = { ...process.env };
  delete env[LIVE_OUTPUT_ENV];
  if (live) env[LIVE_OUTPUT_ENV] = "1";
  return Bun.spawn({
    cmd: [process.execPath, "run", wrapperPath, testPath],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
};

const fixtureNames = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
    .map((entry) => entry.name)
    .sort();

describe("scenario source-mapper reporter", async () => {
  for (const name of await fixtureNames()) {
    test(`rewrites ${name} fixture output`, async () => {
      const GITHUB_ACTIONS_ENV = "GITHUB_ACTIONS";
      const previousGithubActions = process.env.GITHUB_ACTIONS;
      const input = (await readFile(resolve(fixturesRoot, name, "input.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );
      const expected = (await readFile(resolve(fixturesRoot, name, "expected.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );

      try {
        delete process.env[GITHUB_ACTIONS_ENV];
        expect(rewriteScenarioSourceMappedOutput(input, { repoRoot })).toBe(expected);
      } finally {
        if (previousGithubActions === undefined) delete process.env[GITHUB_ACTIONS_ENV];
        else process.env.GITHUB_ACTIONS = previousGithubActions;
      }
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

      const runWrapper = async (testPath: string, live: boolean): Promise<number> => {
        const proc = spawnWrapper(testPath, live);
        await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        return proc.exited;
      };

      expect(await runWrapper(passingTest, false)).toBe(0);
      expect(await runWrapper(failingTest, false)).not.toBe(0);
      expect(await runWrapper(passingTest, true)).toBe(0);
      expect(await runWrapper(failingTest, true)).not.toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("live mode tees child output before exit, then prints the banners and the mapped document", async () => {
    // Given: the child cannot pass until the parent observes its live marker.
    const tempRoot = await mkdtemp(join(tmpdir(), "lando-guide-live-"));
    const testPath = join(tempRoot, "live.test.ts");
    const release = join(tempRoot, "release");
    try {
      await writeFile(
        testPath,
        [
          'import { test } from "bun:test";',
          'test("handshake", async () => {',
          '  console.log("LIVE-MARKER");',
          "  const deadline = Date.now() + 20_000;",
          `  while (!(await Bun.file(${JSON.stringify(release)}).exists())) {`,
          '    if (Date.now() >= deadline) throw new Error("release deadline exceeded");',
          "    await Bun.sleep(25);",
          "  }",
          "}, 25_000);",
        ].join("\n"),
      );
      // When: consume both pipes concurrently, but release only after the marker.
      const proc = spawnWrapper(testPath, true);
      const stderrPromise = new Response(proc.stderr).text();
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = "";
      let sawMarkerBeforeRelease = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline(null), 15_000);
      });
      try {
        let pending = reader.read();
        while (true) {
          const result = await Promise.race([pending, deadline]);
          if (result === null || result.done) break;
          stdout += decoder.decode(result.value, { stream: true });
          pending = reader.read();
          if (stdout.includes("LIVE-MARKER")) {
            sawMarkerBeforeRelease = true;
            await writeFile(release, "release");
            break;
          }
        }
        clearTimeout(timer);
        for (let result = await pending; !result.done; result = await reader.read()) {
          stdout += decoder.decode(result.value, { stream: true });
        }
        stdout += decoder.decode();
        const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
        // Then: one live copy precedes the authoritative mapped copy.
        expect(sawMarkerBeforeRelease).toBe(true);
        expect(exitCode).toBe(0);
        expect(stdout.indexOf(LIVE_OUTPUT_BANNER)).toBeGreaterThanOrEqual(0);
        expect(stdout.indexOf(LIVE_OUTPUT_BANNER)).toBeLessThan(stdout.indexOf("LIVE-MARKER"));
        expect(stdout.indexOf("LIVE-MARKER")).toBeLessThan(stdout.indexOf(MAPPED_OUTPUT_BANNER));
        expect(stdout.indexOf(MAPPED_OUTPUT_BANNER)).toBeLessThan(stdout.lastIndexOf("LIVE-MARKER"));
        expect(stdout.split("LIVE-MARKER").length - 1).toBe(2);
        expect(stderr).toContain("1 pass");
      } finally {
        clearTimeout(timer);
        reader.releaseLock();
        proc.kill();
        await proc.exited;
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("off mode keeps one mapped document on stdout and writes nothing to stderr", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lando-guide-off-"));
    try {
      // Given: a passing child with live output explicitly disabled.
      const testPath = join(tempRoot, "passing.test.ts");
      await writeFile(testPath, 'import { test } from "bun:test"; test("passes", () => {});');
      // When: drain both pipes while waiting for exit.
      const proc = spawnWrapper(testPath, false);
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // Then: only one mapped document is emitted, on stdout.
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain(LIVE_OUTPUT_BANNER);
      expect(stdout).not.toContain(MAPPED_OUTPUT_BANNER);
      expect(stdout.split("1 pass").length - 1).toBe(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("both modes drain heavy stdout and stderr without deadlock", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lando-guide-heavy-"));
    try {
      // Given: each pipe receives four times a 64 KiB pipe buffer.
      const testPath = join(tempRoot, "heavy.test.ts");
      await writeFile(
        testPath,
        [
          'import { test } from "bun:test";',
          'test("heavy", async () => {',
          '  await Promise.all([Bun.write(Bun.stdout, "o".repeat(262144)), Bun.write(Bun.stderr, "e".repeat(262144))]);',
          "});",
        ].join("\n"),
      );
      for (const live of [false, true]) {
        // When: both modes drain both pipes concurrently.
        const proc = spawnWrapper(testPath, live);
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        // Then: every mapped and live copy is complete, not merely one of the copies.
        expect(exitCode).toBe(0);
        expect(stdout.split("o".repeat(262144)).length - 1).toBe(live ? 2 : 1);
        expect(stdout.split("e".repeat(262144)).length - 1).toBe(1);
        expect(stderr.split("e".repeat(262144)).length - 1).toBe(live ? 1 : 0);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
