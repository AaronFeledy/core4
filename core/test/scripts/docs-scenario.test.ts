import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, setDefaultTimeout, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedRoot = resolve(repoRoot, "test/scenarios/generated/guides");

setDefaultTimeout(15_000);

const guideContent = (guideId: string, run = '<Run command="version" />'): string =>
  [
    "---",
    `id: ${guideId}`,
    "provider: test",
    "---",
    "",
    "<Guide>",
    '  <Scenario id="runs">',
    '    <Step name="run">',
    '      <Variable name="appName" value="node-postgres" display="Node/Postgres" />',
    `      ${run}`,
    "    </Step>",
    "  </Scenario>",
    "</Guide>",
    "",
  ].join("\n");

const hiddenGuideContent = (guideId: string): string =>
  [
    "---",
    `id: ${guideId}`,
    "provider: test",
    "---",
    "",
    "<Guide>",
    '  <Scenario id="runs">',
    '    <Hidden reason="seed deterministic state invisibly">',
    '      <Step name="seed">',
    '        <Variable name="seedName" value="seed-app" display="Seed App" />',
    '        <UseFixture name="hidden-fixture" />',
    "      </Step>",
    "    </Hidden>",
    '    <Step name="run">',
    '      <Run command="version" />',
    "    </Step>",
    "  </Scenario>",
    "</Guide>",
    "",
  ].join("\n");

const writeGuide = async (guideId: string, content: string): Promise<void> => {
  const guidePath = resolve(repoRoot, "docs/guides", `${guideId}.mdx`);
  await mkdir(dirname(guidePath), { recursive: true });
  await Bun.write(guidePath, content);
};

const removeGuide = async (guideId: string): Promise<void> => {
  await rm(resolve(repoRoot, "docs/guides", `${guideId}.mdx`), { force: true });
  await rm(resolve(repoRoot, "docs/guides", guideId), { force: true, recursive: true });
  await rm(resolve(generatedRoot, guideId), { force: true, recursive: true });
};

const runDocsScenario = async (
  args: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", "docs:scenario", ...args],
    cwd: repoRoot,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("docs:scenario author command", () => {
  test("runs one green guide and narrows by scenario", async () => {
    const guideId = "docs-scenario-green";
    try {
      await writeGuide(guideId, guideContent(guideId));
      const result = await runDocsScenario([guideId, "--scenario", "runs"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("1 pass");
      expect(await Bun.file(resolve(generatedRoot, guideId, "runs.test.ts")).exists()).toBe(true);
    } finally {
      await removeGuide(guideId);
    }
  });

  test("returns non-zero when the selected scenario fails", async () => {
    const guideId = "docs-scenario-red";
    try {
      await writeGuide(guideId, guideContent(guideId, '<Run command="version" expectExit={1} />'));
      const result = await runDocsScenario([guideId, "--scenario", "runs"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("toBe(1)");
      expect(result.stderr).toContain("[docs-scenario-red:runs]");
      expect(result.stderr).toContain("at docs/guides/docs-scenario-red.mdx:10");
      expect(result.stderr).toContain(
        "Generated: test/scenarios/generated/guides/docs-scenario-red/runs.test.ts",
      );
    } finally {
      await removeGuide(guideId);
    }
  });

  test("prints an explain plan without running tests", async () => {
    const guideId = "docs-scenario-explain";
    try {
      await writeGuide(guideId, guideContent(guideId));
      const result = await runDocsScenario([guideId, "--explain"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("error:");
      expect(result.stdout).toMatchInlineSnapshot(`
"Guide: docs-scenario-explain
Scenario: runs
Render: true
Source: docs/guides/docs-scenario-explain.mdx:7
Step: run (Variable, Run)
"
`);
    } finally {
      await removeGuide(guideId);
    }
  });

  test("prints stable debug details", async () => {
    const guideId = "docs-scenario-debug";
    try {
      await writeGuide(guideId, guideContent(guideId));
      const result = await runDocsScenario([guideId, "--debug", "--scenario=runs"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        [
          "Generated: test/scenarios/generated/guides/docs-scenario-debug/runs.test.ts",
          "Source map: docs/guides/docs-scenario-debug.mdx:7, docs/guides/docs-scenario-debug.mdx:8, docs/guides/docs-scenario-debug.mdx:10",
          "Variable: appName value=node-postgres display=Node/Postgres",
        ].join("\n"),
      );
    } finally {
      await removeGuide(guideId);
    }
  });

  test("prints hidden steps and their components in explain and debug output", async () => {
    const guideId = "docs-scenario-hidden";
    try {
      await writeGuide(guideId, hiddenGuideContent(guideId));
      await mkdir(resolve(repoRoot, "docs/guides", guideId, "fixtures/hidden-fixture"), { recursive: true });

      const explain = await runDocsScenario([guideId, "--explain"]);

      expect(explain.exitCode).toBe(0);
      expect(explain.stdout).toContain(["Step: seed (Variable, UseFixture)", "Step: run (Run)"].join("\n"));

      const debug = await runDocsScenario([guideId, "--debug", "--scenario=runs"]);

      expect(debug.exitCode).toBe(0);
      expect(debug.stdout).toContain("Variable: seedName value=seed-app display=Seed App");
      expect(debug.stdout).toContain("Fixture: hidden-fixture -> <testDir>/hidden-fixture");
    } finally {
      await removeGuide(guideId);
    }
  });

  test("rejects unknown and deferred flags with typed remediation", async () => {
    const result = await runDocsScenario(["node-postgres", "--variant=beta"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code: NotImplementedError");
    expect(result.stderr).toContain("not supported yet");
  });
});
