import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { getLandofileReferencedFiles } from "../src/load-expression-provenance.ts";
import { authoredRecipe, resolveAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-tooling-stages-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolve = () =>
  resolveAuthoredIncludes({
    landofile: {
      includes: [{ source: "./tasks/fragment.yml", kind: "tooling", namespace: "qa" }],
      recipe: authoredRecipe({ required: false }),
    },
    appRoot: root,
    cacheRoot: join(root, ".cache"),
    ports: makeTestLandofilePorts(join(root, ".cache")),
    stateStore: makeTestLandofileStateStore(),
  });

test.each([
  "tooling: \"{{ { build: { cmd: 'echo ok', flags: { debug: { required: recipe.required } } } } }}\"\n",
  'tooling:\n  build:\n    cmd: echo ok\n    flags:\n      debug: "{{ { required: recipe.required } }}"\n',
])("materializes whole-value tooling expressions before value validation (%#)", async (content) => {
  // Given
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "fragment.yml"), content);
  // When
  const loaded = await Effect.runPromise(resolve());
  // Then
  expect(loaded.tooling?.["qa:build"]?.flags?.debug?.required).toBe(false);
});

test("resolves file helpers relative to the tooling fragment and retains their dependencies", async () => {
  // Given
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "commands.json"), JSON.stringify({ wrong: { cmd: "wrong-root" } }));
  const dataPath = join(root, "tasks", "commands.json");
  await writeFile(
    dataPath,
    JSON.stringify({ build: { cmd: "echo ok", flags: { debug: { required: false } } } }),
  );
  await writeFile(join(root, "tasks", "fragment.yml"), "tooling: \"{{ load('./commands.json') }}\"\n");
  // When
  const loaded = await Effect.runPromise(resolve());
  // Then
  expect(loaded.tooling?.["qa:build"]?.flags?.debug?.required).toBe(false);
  expect(getLandofileReferencedFiles(loaded).some((file) => file.absolutePath === dataPath)).toBe(true);
});

test("materializes a nested tooling include collection before resolving it", async () => {
  // Given
  await mkdir(join(root, "tasks"));
  await writeFile(
    join(root, "tasks", "fragment.yml"),
    "toolingIncludes: \"{{ { nested: { file: './nested.yml' } } }}\"\n",
  );
  await writeFile(join(root, "tasks", "nested.yml"), "tooling:\n  build:\n    cmd: nested\n");
  // When
  const loaded = await Effect.runPromise(resolve());
  // Then
  expect(loaded.tooling?.["qa:nested:build"]?.cmd).toBe("nested");
});

test.each([
  { content: "tooling:\n  build:\n    cmd: 42\n", path: ["tooling", "build", "cmd"] },
  { content: "tooling: false\n", path: ["tooling"] },
  { content: "toolingIncludes: false\n", path: ["toolingIncludes"] },
  {
    content: "tooling:\n  build:\n    cmd: build\n    flags:\n      debug: false\n",
    path: ["tooling", "build", "flags", "debug"],
  },
])("preserves structured fragment validation failures at $path", async ({ content, path }) => {
  // Given
  await mkdir(join(root, "tasks"));
  const file = join(root, "tasks", "fragment.yml");
  await writeFile(file, content);
  // When
  const error = await Effect.runPromise(resolve().pipe(Effect.flip));
  // Then
  expect(error).toMatchObject({
    _tag: "LandofileValidationError",
    file,
    issues: expect.arrayContaining([expect.objectContaining({ path })]),
  });
});

test("attributes an unresolved tooling flag expression to its authored fragment", async () => {
  // Given
  await mkdir(join(root, "tasks"));
  const filePath = join(root, "tasks", "fragment.yml");
  await writeFile(
    filePath,
    'tooling:\n  build:\n    cmd: build\n    flags:\n      debug:\n        required: "{{ recipe.missing }}"\n',
  );
  // When
  const error = await Effect.runPromise(resolve().pipe(Effect.flip));
  // Then
  expect(error).toMatchObject({
    _tag: "ConfigExpressionError",
    filePath,
    path: "tooling.build.flags.debug.required",
    expression: "{{ recipe.missing }}",
  });
});

test("preserves a tooling fragment parse failure and its source file", async () => {
  // Given
  await mkdir(join(root, "tasks"));
  const filePath = join(root, "tasks", "fragment.yml");
  await writeFile(filePath, "tooling:\n  build:\n    cmd: *missing\n");
  // When
  const error = await Effect.runPromise(resolve().pipe(Effect.flip));
  // Then
  expect(error).toMatchObject({ _tag: "LandofileParseError", filePath });
});

test("rejects forbidden nested keys introduced by a whole-value expression", async () => {
  // Given
  await mkdir(join(root, "tasks"));
  await writeFile(
    join(root, "tasks", "fragment.yml"),
    "toolingIncludes: \"{{ { child: { file: './nested.yml', dir: './other' } } }}\"\n",
  );
  // When
  const error = await Effect.runPromise(resolve().pipe(Effect.flip));
  // Then
  expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "forbidden-field" });
});
