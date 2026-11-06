import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { emitGuideScenarioTests, parseGuideScenarioAst } from "../../../scripts/build-guide-scenarios.ts";
import { lintGuideContent } from "../../../scripts/lint-guides.ts";
import { SOURCE, document, scenario, step } from "./fixtures/guide-conformance.ts";

test.each([
  ["prose", "Only prose."],
  ["empty step", step("")],
  ["fixture only", step('<UseFixture name="sample" />')],
  ["cleanup only", step("<Cleanup />")],
  ["inspect only", step('<Inspect file="out.txt" />')],
  ["inline only", step('<Inline lang="ts" code="example" justification="Illustrative output" />')],
])("rejects %s with the same compiler and lint diagnostic", (_name, body) => {
  const source = document(scenario(body));
  expect(() => parseGuideScenarioAst(SOURCE, source)).toThrow();
  try {
    parseGuideScenarioAst(SOURCE, source);
  } catch (error) {
    expect(error).toMatchObject({
      code: "guide.scenario.no-behavior",
      sourcePath: SOURCE,
      scenario: "reader",
    });
  }
  if (_name !== "fixture only")
    expect(lintGuideContent(SOURCE, source).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "guide.scenario.no-behavior",
    );
});

test("rejects an empty selected tab and skips an omitted tab with a reason", () => {
  const noTabs = document(scenario("<Tabs />"), "tabs: [linux, macos]\n");
  expect(() => parseGuideScenarioAst(SOURCE, noTabs)).toThrow();
  expect(lintGuideContent(SOURCE, noTabs).diagnostics.map((diagnostic) => diagnostic.code)).toContain(
    "guide.scenario.no-behavior",
  );
  const empty = document(
    scenario(
      `<Tabs><Tab name="linux"></Tab><Tab name="macos">${step('<Run command="version" />')}</Tab></Tabs>`,
    ),
    "tabs: [linux, macos]\n",
  );
  expect(() => parseGuideScenarioAst(SOURCE, empty)).toThrow();
  const omitted = document(
    scenario(`<Tabs><Tab name="linux">${step('<Run command="version" />')}</Tab></Tabs>`),
    "tabs: [linux, macos]\n",
  );
  const guide = parseGuideScenarioAst(SOURCE, omitted);
  expect(guide.cells.map((cell) => cell.resolved.skipOnly)).toEqual([false, true]);
  expect(guide.cells[1]?.resolved.skipReason).toContain("axis default=macos has no authored tab");
});

test("an explicitly skipped scenario produces a skipped child test", async () => {
  const source = document(
    scenario(`<Skip reason="Awaiting provider support">${step('<Run command="version" />')}</Skip>`),
  );
  const root = await mkdtemp(join(tmpdir(), "lando-guide-skip-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
    const files = await emitGuideScenarioTests([parseGuideScenarioAst(SOURCE, source)], root);
    const generated = await Bun.file(join(root, files[0] ?? "")).text();
    expect(generated).toContain("test.skip");
    expect(generated).toContain("Awaiting provider support");
    const child = Bun.spawnSync([process.execPath, "test", ...files.map((file) => join(root, file))], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stderr.toString()).toMatch(/1 skip/);
    expect(child.stderr.toString()).not.toMatch(/1 pass/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a library Run with no assertions fails in the actual generated child", async () => {
  const source = document(
    scenario(step('<Run runtime="library" code="yield* Effect.void;" displayCode="await setup();" />')),
  );
  const root = await mkdtemp(join(tmpdir(), "lando-guide-empty-library-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
    const files = await emitGuideScenarioTests([parseGuideScenarioAst(SOURCE, source)], root);
    const child = Bun.spawnSync([process.execPath, "test", ...files.map((file) => join(root, file))], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stderr.toString()).toBe(1);
    expect(child.stderr.toString()).toMatch(/1 fail/);
    expect(child.stderr.toString()).toContain("assertion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "successful CLI Run",
    body: '<Run command="version" />',
    runner: 'async () => ({ command: ["version"], stdout: "ok", stderr: "", exitCode: 0, events: [] })',
    exit: 0,
    count: /1 pass/,
  },
  {
    name: "failing CLI Run",
    body: '<Run command="version" />',
    runner: 'async () => ({ command: ["version"], stdout: "", stderr: "failed", exitCode: 1, events: [] })',
    exit: 1,
    count: /1 fail/,
  },
  {
    name: "standalone command Verify",
    body: '<Verify command="version" />',
    runner: 'async () => ({ command: ["version"], stdout: "ok", stderr: "", exitCode: 0, events: [] })',
    exit: 0,
    count: /1 pass/,
  },
  {
    name: "hidden setup Run",
    body: "",
    scenarioBody: `<Hidden reason="Private setup">${step('<Run command="version" />')}</Hidden>`,
    runner: 'async () => ({ command: ["version"], stdout: "ok", stderr: "", exitCode: 0, events: [] })',
    exit: 0,
    count: /1 pass/,
  },
  {
    name: "asserting library Run",
    body: '<Run runtime="library" code="expect(true).toBe(true); yield* Effect.void;" displayCode="await check();" />',
    exit: 0,
    count: /1 pass/,
  },
  {
    name: "original library failure",
    body: '<Run runtime="library" code="throw new Error(\'original failure\');" displayCode="await check();" />',
    exit: 1,
    count: /1 fail/,
    message: "original failure",
  },
  {
    name: "conditional library assertion never reached",
    body: '<Run runtime="library" code="if (false) expect(true).toBe(true); yield* Effect.void;" displayCode="await check();" />',
    exit: 1,
    count: /1 fail/,
    message: "assertion",
  },
  {
    name: "original shell failure",
    body: '<Run shell="printf hi" />',
    exit: 1,
    count: /1 fail/,
    message: "NotImplementedError",
  },
])(
  "generated child preserves $name outcome",
  async ({ body, scenarioBody, runner, exit, count, message }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-guide-behavior-"));
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
      const files = await emitGuideScenarioTests(
        [parseGuideScenarioAst(SOURCE, document(scenario(scenarioBody ?? step(body))))],
        root,
      );
      if (runner !== undefined) {
        const path = join(root, files[0] ?? "");
        await Bun.write(
          path,
          (await Bun.file(path).text()).replace(
            'guideId: "conformance",',
            `guideId: "conformance", runCli: ${runner},`,
          ),
        );
      }
      const child = Bun.spawnSync([process.execPath, "test", ...files.map((file) => join(root, file))], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode, child.stderr.toString()).toBe(exit);
      expect(child.stderr.toString()).toMatch(count);
      if (message !== undefined) expect(child.stderr.toString()).toContain(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
