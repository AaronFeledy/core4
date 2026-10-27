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
