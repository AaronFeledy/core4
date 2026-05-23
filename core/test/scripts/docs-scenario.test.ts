import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatedRoot = resolve(repoRoot, "test/scenarios/generated/guides");

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

const writeGuide = async (guideId: string, content: string): Promise<void> => {
  const guidePath = resolve(repoRoot, "docs/guides", `${guideId}.mdx`);
  await mkdir(dirname(guidePath), { recursive: true });
  await Bun.write(guidePath, content);
};

const removeGuide = async (guideId: string): Promise<void> => {
  await rm(resolve(repoRoot, "docs/guides", `${guideId}.mdx`), { force: true });
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

  test("rejects unknown and deferred flags with typed remediation", async () => {
    const result = await runDocsScenario(["node-postgres", "--variant=beta"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("code: NotImplementedError");
    expect(result.stderr).toContain("Phase 3 Beta");
    expect(result.stderr).toContain("spec/ROADMAP.md");
  });
});
