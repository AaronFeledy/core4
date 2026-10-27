import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildGuideScenarioAst,
  buildGuideScenarioTests,
  emitGuideScenarioTests,
  emitPublicTranscripts,
  parseGuideScenarioAst,
} from "../../../scripts/build-guide-scenarios.ts";
import { buildRecipeReadmes } from "../../../scripts/build-recipe-readmes.ts";
import { SOURCE, document, project, scenario, step } from "./fixtures/guide-conformance.ts";

test.each([
  {
    name: "unexpected runner rejection",
    body: '<Run command="version" />',
    runner: 'async () => { throw { _tag: "HarnessError", message: "runner rejected" }; }',
    exit: 1,
  },
  {
    name: "runner rejection cannot be consumed by errorTag",
    body: '<Run command="version" /><Verify errorTag="HarnessError" />',
    runner: 'async () => { throw { _tag: "HarnessError", message: "runner rejected" }; }',
    exit: 1,
  },
  ...[
    { name: "exact result tag", tag: "LandofileNotFoundError", actual: "LandofileNotFoundError", exit: 0 },
    { name: "prefix result tag", tag: "LandofileNotFound", actual: "LandofileNotFoundError", exit: 1 },
  ].map(({ name, tag, actual, exit }) => ({
    name,
    body: `<Run command="version" expectExit={1} /><Verify errorTag="${tag}" expect={{ regex: "missing file" }} />`,
    runner: `async () => ({ command: ["version"], _tag: ${JSON.stringify(actual)}, stdout: "", stderr: "missing file", exitCode: 1, events: [] })`,
    exit,
  })),
  ...[
    { name: "JSON errors code", tag: "LandofileNotFoundError", exit: 0 },
    { name: "JSON errors code prefix", tag: "LandofileNotFound", exit: 1 },
    { name: "JSON remediation is not a tag", tag: "OtherError", exit: 1 },
  ].map(({ name, tag, exit }) => ({
    name,
    body: `<Run command="version" expectExit={1} /><Verify errorTag="${tag}" />`,
    runner: `async () => ({ command: ["version"], stdout: JSON.stringify({ errors: [{ code: "LandofileNotFoundError", message: "missing file", remediation: "OtherError" }] }), stderr: "", exitCode: 1, events: [] })`,
    exit,
  })),
  {
    name: "canonical JSON error tag",
    body: '<Run command="version" expectExit={1} /><Verify errorTag="LandofileNotFoundError" />',
    runner:
      'async () => ({ command: ["version"], stdout: JSON.stringify({ apiVersion: "v4", command: "version", ok: false, error: { _tag: "LandofileNotFoundError", message: "missing file", remediation: "Create a Landofile" }, warnings: [], deprecations: [] }), stderr: "", exitCode: 1, events: [] })',
    exit: 0,
  },
  {
    name: "tagged stderr",
    body: '<Run command="version" expectExit={1} /><Verify errorTag="LandofileNotFoundError" />',
    runner:
      'async () => ({ command: ["version"], stdout: "", stderr: "code: LandofileNotFoundError\\nmessage: missing file\\n", exitCode: 1, events: [] })',
    exit: 0,
  },
  {
    name: "success clears previous result tag",
    body: '<Run command="fail" expectExit={1} /><Run command="version" /><Verify errorTag="LandofileNotFoundError" />',
    runner:
      'async (command) => command[0] === "fail" ? { command, _tag: "LandofileNotFoundError", stdout: "", stderr: "missing file", exitCode: 1, events: [] } : { command, stdout: "LandofileNotFoundError", stderr: "", exitCode: 0, events: [] }',
    exit: 1,
  },
  ...[
    { name: "valid canonical schema", schema: "MessageInfoEvent", body: "ok", exit: 0 },
    { name: "wrong canonical schema shape", schema: "MessageInfoEvent", body: 42, exit: 1 },
    { name: "unknown schema", schema: "StatusEvent", body: "ok", exit: 1 },
    { name: "inherited name is not a schema", schema: "toString", body: "ok", exit: 1 },
  ].map(({ name, schema, body, exit }) => ({
    name,
    body: `<Run command="version" /><Verify event="message.info" expect={{ schema: "${schema}" }} />`,
    runner: `async () => ({ command: ["version"], stdout: "", stderr: "", exitCode: 0, events: [] })`,
    event: { _tag: "message.info", body, timestamp: "2026-10-27T00:00:00.000Z" },
    exit,
  })),
])("generated runtime handles $name", async ({ body, runner, exit, ...fixture }) => {
  // Given: a generated scenario with an injected CLI boundary result.
  const root = await mkdtemp(join(tmpdir(), "lando-guide-assertions-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
    const guide = parseGuideScenarioAst(SOURCE, document(scenario(step(body))));
    const files = await emitGuideScenarioTests([guide], root);
    for (const file of files) {
      const path = join(root, file);
      const generated = await Bun.file(path).text();
      await Bun.write(
        path,
        generated
          .replace('guideId: "conformance",', `guideId: "conformance", runCli: ${runner},`)
          .replace(
            "Effect.gen(function* () {",
            `Effect.gen(function* () {${"event" in fixture ? `context.events.push(${JSON.stringify(fixture.event)});` : ""}`,
          ),
      );
    }

    // When: Bun executes the actual generated test, not just its source text.
    const child = Bun.spawnSync([process.execPath, "test", ...files.map((file) => join(root, file))], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Then: both the process verdict and a positive executed-test count agree.
    expect(child.exitCode, child.stderr.toString()).toBe(exit);
    expect(child.stderr.toString()).toMatch(exit === 0 ? /1 pass/ : /1 fail/);
    if (runner.includes("throw")) expect(child.stderr.toString()).toContain("runner rejected");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("executes generated CLI values and opaque library code while displaying reader bindings", async () => {
  const source = document(
    [
      scenario(
        step(
          '<Variable name="command" value="version" display="reader-command" /><Run command="{{command}}" /><Verify command="{{command}}" />',
        ),
        "cli",
      ),
      scenario(
        step(
          '<Run runtime="library" code={`expect("{{unbound}}".length).toBe(11); yield* Effect.void;`} displayCode={`await read("{{reader}}");`} />',
        ),
        "library",
      ),
    ].join("\n"),
  );
  const root = await mkdtemp(join(tmpdir(), "lando-guide-conformance-"));
  try {
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir");
    const guide = parseGuideScenarioAst(SOURCE, source);
    const files = await emitGuideScenarioTests([guide], root);

    const child = Bun.spawnSync([process.execPath, "test", ...files.map((file) => join(root, file))], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stderr.toString()).toMatch(/2 pass/);
    const result = project(source);
    expect(result.cells[0]?.transcript?.frames[1]?.commandDisplay).toBe("reader-command");
    expect(result.readmes[0]?.markdown).toContain("reader-command");
    expect(result.cells[1]?.transcript?.frames[1]?.commandDisplay).toBe('await read("{{reader}}");');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test.each([
  {
    name: "executable",
    build: buildGuideScenarioTests,
    output: "test/scenarios/generated/guides/conformance/stale.test.ts",
  },
  { name: "scaffold", build: buildRecipeReadmes, output: "recipes/conformance/.scaffold/default.md" },
  {
    name: "transcript",
    build: async (root: string) => emitPublicTranscripts(await buildGuideScenarioAst(root), root),
    output: "dist/transcripts/public/guides/conformance/stale.json",
  },
])("preserves previous $name output when canonical validation rejects source", async ({ build, output }) => {
  const root = await mkdtemp(join(tmpdir(), "lando-guide-validation-"));
  try {
    await mkdir(join(root, "recipes/conformance/.scaffold"), { recursive: true });
    await Bun.write(
      join(root, SOURCE),
      document(
        scenario(step('<Variable name="unused" value="private-value" /><Run command="lando version" />')),
      ),
    );
    await Bun.write(join(root, output), "previous-output");

    await expect(build(root)).rejects.toMatchObject({ code: "guide.variable.unused" });

    expect(await Bun.file(join(root, output)).text()).toBe("previous-output");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
