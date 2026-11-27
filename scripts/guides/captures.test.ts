import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGuideScenarioAst, renderScenarioTest } from "../build-guide-scenarios.ts";

const source = "docs/guides/capture-example.mdx";
const guide = (steps: string, hidden = true) =>
  `---
id: capture-example
provider: test
---
<Guide>
<Scenario id="capture-case"${hidden ? ' render={false} reason="Check guide captures"' : ""}>
${steps}
</Scenario>
</Guide>`;
const capture = (command: string) =>
  `<Run command="${command}" capture={{ name: "id", json: "handle.id" }} />`;
const before = (component: string) => `<Step name="before">\n${component}\n</Step>`;
const after = (component: string) => `<Step name="after">\n${component}\n</Step>`;
const use = '<Run command="lando inspect-result {{capture:id}}" />';

test.each([
  [guide(before(use)), "guide.capture.unknown"],
  [
    guide(`${before(use)}\n${after(capture("lando start --format=json"))}`),
    "guide.capture.before-declaration",
  ],
  [guide(before(capture("lando start")), false), "guide.capture.hidden-only"],
  [guide(before(capture("lando start"))), "guide.capture.json-required"],
  [guide(before(capture("lando start --help --format=json"))), "guide.capture.json-required"],
  [guide(before(capture("lando start -- --format=json"))), "guide.capture.json-required"],
])("rejects invalid capture declarations or uses (%s)", (mdx, code) => {
  expect(() => parseGuideScenarioAst(source, mdx)).toThrow(expect.objectContaining({ code }));
});

const runScenario = async (steps: string, runCli: string) => {
  const ast = parseGuideScenarioAst(source, guide(steps));
  const scenario = ast.scenarios[0];
  if (scenario === undefined) throw new Error("Missing capture scenario");
  const root = await mkdtemp(join(tmpdir(), "lando-guide-capture-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), "junction");
    const path = join(root, "capture.test.ts");
    const code = renderScenarioTest(ast, scenario, undefined, "linux").replace(
      'guideId: "capture-example",',
      `guideId: "capture-example", repositoryRoot: ${JSON.stringify(root)}, runCli: ${runCli},`,
    );
    await Bun.write(path, code);
    const proc = Bun.spawn({
      cmd: [process.execPath, "test", path],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [codeExit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const cleanupPath = join(root, "cleaned");
    const cleaned = (await Bun.file(cleanupPath).exists()) ? await Bun.file(cleanupPath).text() : undefined;
    return { codeExit, output: stdout + stderr, stderr, cleaned };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("passes a nested result string to the next command as one argument", async () => {
  const value = 'two words; "quoted"';
  const { codeExit, stderr } = await runScenario(
    `${before(capture("lando start --format=json"))}\n${after(use)}`,
    `async (argv) => argv[0] === "start"
      ? { command: argv, exitCode: 0, events: [], stderr: "", stdout: ${JSON.stringify(JSON.stringify({ result: { handle: { id: value } } }))} }
      : { command: argv, exitCode: argv.length === 2 && argv[1] === ${JSON.stringify(value)} ? 0 : 2, events: [], stdout: "", stderr: JSON.stringify(argv) }`,
  );
  expect(codeExit, stderr).toBe(0);
}, 20_000);

test("skips only the cleanup command whose capture was not produced", async () => {
  const { codeExit, output, stderr, cleaned } = await runScenario(
    before(capture("lando start --format=json")) +
      "\n" +
      after(`<Cleanup />
${use}
<Run command="lando finish" />`),
    `async (argv) => {
      if (argv[0] !== "start") await Bun.write("cleaned", (await Bun.file("cleaned").exists() ? await Bun.file("cleaned").text() : "") + argv[0]);
      return { command: argv, exitCode: 0, events: [], stdout: '{"result":{"handle":{"id":[]}}}', stderr: "" };
    }`,
  );
  expect(codeExit).toBe(1);
  expect(stderr).toContain("ScenarioCaptureError");
  expect(output).toContain(
    'Skipped cleanup command `lando inspect-result {{capture:id}}`: capture "id" has no value',
  );
  expect(cleaned).toBe("finish");
}, 20_000);

test("names a capture source that does not print a JSON envelope", async () => {
  const { codeExit, stderr } = await runScenario(
    before(capture("lando start --format=json")),
    `async (argv) => ({ command: argv, exitCode: 0, events: [], stdout: "plain text", stderr: "" })`,
  );
  expect(codeExit).toBe(1);
  expect(stderr).toContain('stdout is not a single JSON envelope: "plain text"');
}, 20_000);
