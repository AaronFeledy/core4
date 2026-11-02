import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { createLoadFailureRecorder } from "../src/load-failures.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { resolveToolingIncludes } from "../src/tooling-includes.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-load-aggregate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const inputs = () => ({
  ports: makeTestLandofilePorts(root),
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [], context: { env: {}, scope: "test", bootstrapLevel: "minimal" as const } },
});
const failure = () =>
  Effect.runPromise(Effect.flip(loadLandofileLayers(root, join(root, ".lando.yml"), inputs())));

test("reports missing includes from both layers without effective validation (#1646)", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nincludes: [./missing-a.yml]\nservices:\n  web:\n    imgae: typo\n",
  );
  await writeFile(join(root, ".lando.local.yml"), "includes: [./missing-b.yml]\n");
  const error = await failure();
  expect(error._tag).toBe("LandofileLoadError");
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toHaveLength(2);
  expect(error.failures).toMatchObject([
    { _tag: "LandofileIncludeError", file: join(root, ".lando.yml"), path: ["includes", 0] },
    { _tag: "LandofileIncludeError", file: join(root, ".lando.local.yml"), path: ["includes", 0] },
  ]);
});

test("preserves a single include failure", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./missing.yml]\n");
  expect(await failure()).toMatchObject({
    _tag: "LandofileIncludeError",
    file: join(root, ".lando.yml"),
    path: ["includes", 0],
    kind: "fetch-failed",
  });
});

test("retains nested attribution for independent sibling failures", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./fragment.yml]\n");
  await writeFile(join(root, "fragment.yml"), "includes: [./a.yml, ./b.yml]\n");
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toMatchObject([
    { file: join(root, "fragment.yml"), path: ["includes", 0] },
    { file: join(root, "fragment.yml"), path: ["includes", 1] },
  ]);
});

test.each([
  ["eager", "x-a: \"{{ load('./a.yml') }}\"\nx-b: \"{{ load('./b.yml') }}\"\n"],
  ["env", 'x-a: "{{ env.LANDO_TEST_UNSET_A }}"\nx-b: "{{ env.LANDO_TEST_UNSET_B }}"\n'],
])("reports both %s expression destinations", async (_kind, authored) => {
  await writeFile(join(root, ".lando.yml"), `name: aggregate\n${authored}`);
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toHaveLength(2);
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(
    snapshot.result.violations.filter((issue) => issue.rule === "landofile.load").map((issue) => issue.path),
  ).toEqual([["x-a"], ["x-b"]]);
});

test("blocks acquisition after an eager include-source failure", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nincludes:\n  - source: \"{{ load('./missing.yml') }}\"\n",
  );
  expect((await failure())._tag).toBe("LandofileParseError");
});

test("records a broken layer and an independent include", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./missing.yml]\n");
  await writeFile(join(root, ".lando.local.yml"), "services: [\n");
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures.map((entry) => entry._tag)).toEqual(["LandofileParseError", "LandofileIncludeError"]);
});

test("does not reinterpret a failed lando expression as semver", async () => {
  await writeFile(join(root, ".lando.yml"), 'name: aggregate\nlando: "{{ env.LANDO_TEST_UNSET_A }}"\n');
  expect((await failure())._tag).toBe("ConfigExpressionError");
});

test("reports tooling include failures from both declaration forms", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nincludes:\n  - kind: tooling\n    source: ./t1.yml\n",
  );
  await writeFile(join(root, ".lando.local.yml"), "toolingIncludes:\n  docs:\n    file: ./t2.yml\n");
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toMatchObject([{ path: ["includes", 0] }, { path: ["toolingIncludes", "docs"] }]);
});

test("retains fragment findings from loaded files alongside every include failure", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./missing-a.yml, ./good.yml]\n");
  await writeFile(join(root, ".lando.local.yml"), "includes: [./missing-b.yml]\n");
  await writeFile(join(root, "good.yml"), "services:\n  web:\n    imgae: typo\n");
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(snapshot.result.valid).toBe(false);
  expect(snapshot.resolved).toBeUndefined();
  const failures = snapshot.result.violations.filter((issue) => issue.rule === "landofile.load");
  expect(failures.map((issue) => issue.source)).toEqual([
    { file: join(root, ".lando.yml"), layer: "canonical", path: ["includes", 0] },
    { file: join(root, ".lando.local.yml"), layer: "local", path: ["includes", 0] },
  ]);
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.validation")).toMatchObject([
    { path: ["services", "web", "imgae"], scopes: ["fragment"], source: { file: join(root, "good.yml") } },
  ]);
});

test("discards the entire later tooling contribution on a collision", async () => {
  await writeFile(join(root, "a.yml"), "tooling:\n  shared: first\n");
  await writeFile(join(root, "b.yml"), "tooling:\n  unique: second\n  shared: conflicting\n");
  const recorder = createLoadFailureRecorder();
  const result = await Effect.runPromise(
    resolveToolingIncludes({
      appRoot: root,
      sourceRoot: root,
      recorder,
      loadScope: { env: {}, recipe: undefined, pendingSites: [], recorder },
      landofile: {
        includes: [
          { kind: "tooling", source: "./a.yml", namespace: "tools" },
          { kind: "tooling", source: "./b.yml", namespace: "tools" },
        ],
      },
    }),
  );
  expect(recorder.failures).toHaveLength(1);
  expect(recorder.failures[0]).toMatchObject({ _tag: "LandofileIncludeError", kind: "forbidden-field" });
  expect(Object.keys(result.tooling)).toEqual(["tools:shared"]);
  expect([...result.defaults.keys()]).toEqual(["tools:shared"]);
});

test("the direct tooling resolver fails with a tagged error for a tooling-only field", async () => {
  const exit = await Effect.runPromiseExit(
    resolveToolingIncludes({
      appRoot: root,
      sourceRoot: root,
      loadScope: { env: {}, recipe: undefined, pendingSites: [] },
      landofile: { includes: [{ source: "./fragment.yml", namespace: "tools" }] },
    }),
  );
  if (exit._tag !== "Failure") throw new Error("expected the tooling-only field to fail");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  expect(error).toMatchObject({
    _tag: "LandofileIncludeError",
    kind: "forbidden-field",
    path: ["includes", 0],
    message: expect.stringContaining('tooling-only field "namespace"'),
  });
});

test.each(["recipe.missing", "recipe", "recipe[env.KEY]"])(
  "suppresses %s after a broken layer but evaluates env sites",
  async (expression) => {
    await writeFile(
      join(root, ".lando.yml"),
      `name: aggregate\nx-recipe: "{{ ${expression} }}"\nx-env: "{{ env.LANDO_TEST_UNSET_A }}"\n`,
    );
    await writeFile(join(root, ".lando.local.yml"), "services: [\n");
    const error = await failure();
    if (error._tag !== "LandofileLoadError") throw error;
    expect(error.failures.map((entry) => entry._tag)).toEqual([
      "LandofileParseError",
      "ConfigExpressionError",
    ]);
  },
);

test.each([
  ["env", "env.LANDO_TEST_UNSET"],
  ["recipe", "recipe.missing"],
])("retains structured authored paths for %s materialization failures", async (_kind, expression) => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\n");
  const file = join(root, ".lando.local.yml");
  await writeFile(file, `x-values:\n  "one.dot": "{{ ${expression} }}"\n`);
  expect(await failure()).toMatchObject({
    _tag: "ConfigExpressionError",
    source: { file, layer: "local", path: ["x-values", "one.dot"] },
    path: ["x-values", "one.dot"],
  });
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.load")).toMatchObject([
    { path: ["x-values", "one.dot"], source: { file, layer: "local", path: ["x-values", "one.dot"] } },
  ]);
});

test("attributes invalid lando ranges to their authored layer field", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\n");
  const file = join(root, ".lando.local.yml");
  await writeFile(file, "lando: invalid-range\n");
  expect(await failure()).toMatchObject({
    _tag: "LandofileParseError",
    sourceFile: file,
    sourcePath: ["lando"],
    layer: "local",
  });
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.load")).toMatchObject([
    { path: ["lando"], source: { file, layer: "local", path: ["lando"] } },
  ]);
});

test("records an oversized layer and still inspects other layers and includes", async () => {
  await writeFile(join(root, ".lando.yml"), `#${"x".repeat(1024 * 1024)}\n`);
  await writeFile(join(root, ".lando.local.yml"), "includes: [./missing.yml]\n");
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toMatchObject([
    { _tag: "LandofileParseError", filePath: join(root, ".lando.yml") },
    { _tag: "LandofileIncludeError", file: join(root, ".lando.local.yml"), path: ["includes", 0] },
  ]);
  expect(error.failures).toHaveLength(2);
});

test("skips malformed include requests without losing later authored indices", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nincludes:\n  - source: 42\n  - ./missing.yml\n",
  );
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toHaveLength(2);
  expect(error.failures[1]).toMatchObject({ _tag: "LandofileIncludeError", path: ["includes", 1] });
});

test("attributes max depth to the crossing entry and still loads a shallower sibling", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./a0.yml, ./good.yml]\n");
  for (let index = 0; index < 10; index++)
    await writeFile(join(root, `a${index}.yml`), `includes: [./a${index + 1}.yml]\n`);
  await writeFile(join(root, "good.yml"), "services:\n  web:\n    imgae: typo\n");
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.load")).toMatchObject([
    { path: ["includes", 0], source: { file: join(root, "a7.yml") } },
  ]);
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.validation")).toMatchObject([
    { source: { file: join(root, "good.yml") } },
  ]);
});

test("records every over-depth tooling sibling at its own authored entry", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\ntoolingIncludes:\n  tasks:\n    file: ./a0.yml\n",
  );
  for (let index = 0; index < 8; index++)
    await writeFile(
      join(root, `a${index}.yml`),
      `toolingIncludes:\n  next:\n    file: ./a${index + 1}.yml\n`,
    );
  await writeFile(
    join(root, "a8.yml"),
    "toolingIncludes:\n  first:\n    file: ./first.yml\n  second:\n    file: ./second.yml\n",
  );
  const error = await failure();
  expect(error._tag).toBe("LandofileLoadError");
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toHaveLength(2);
  expect(error.failures).toMatchObject([
    {
      _tag: "LandofileIncludeError",
      kind: "max-depth",
      file: join(root, "a8.yml"),
      path: ["toolingIncludes", "first"],
    },
    {
      _tag: "LandofileIncludeError",
      kind: "max-depth",
      file: join(root, "a8.yml"),
      path: ["toolingIncludes", "second"],
    },
  ]);
});

test("retires successful env and lando sites instead of publishing them as pending", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nlando: \"{{ default(env.VERSION, '^4') }}\"\nx-value: \"{{ default(env.VALUE, 'ready') }}\"\n",
  );
  const compiled = await Effect.runPromise(loadLandofileLayers(root, join(root, ".lando.yml"), inputs()));
  expect(compiled.pendingSites).toEqual([]);
  expect(compiled.document.lando).toBe("^4");
  expect(compiled.document["x-value"]).toBe("ready");
});

test("retains prior include failures when an environment list cannot normalize", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nincludes: [./a.yml, ./b.yml]\nservices:\n  web:\n    environment: [BARE]\n",
  );
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures.map((entry) => entry._tag)).toEqual([
    "LandofileValidationError",
    "LandofileIncludeError",
    "LandofileIncludeError",
  ]);
});

test("records a corrupt shared lock once and still visits local siblings in every layer", async () => {
  await writeFile(join(root, ".lando.yml"), "name: aggregate\nincludes: [./a.yml]\n");
  await writeFile(join(root, ".lando.local.yml"), "includes: [./b.yml]\n");
  await writeFile(join(root, ".lando.lock.yml"), "::: corrupt :::\n");
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures.map((entry) => entry._tag)).toEqual([
    "LandofileParseError",
    "LandofileIncludeError",
    "LandofileIncludeError",
  ]);
});

test("continues nested tooling siblings after an incompatible entry", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\ntoolingIncludes:\n  tasks:\n    file: ./tasks.yml\n",
  );
  await writeFile(
    join(root, "tasks.yml"),
    "toolingIncludes:\n  invalid:\n    file: ./a.yml\n    dir: forbidden\n  missing:\n    file: ./b.yml\n",
  );
  const error = await failure();
  if (error._tag !== "LandofileLoadError") throw error;
  expect(error.failures).toMatchObject([
    { _tag: "LandofileIncludeError", file: join(root, "tasks.yml"), path: ["toolingIncludes", "invalid"] },
    { _tag: "LandofileIncludeError", file: join(root, "tasks.yml"), path: ["toolingIncludes", "missing"] },
  ]);
});

test("does not diagnose a collision against an incomplete tooling contribution", async () => {
  await writeFile(
    join(root, "a.yml"),
    "toolingIncludes:\n  missing:\n    file: ./absent.yml\ntooling:\n  shared: first\n",
  );
  await writeFile(join(root, "b.yml"), "tooling:\n  shared: second\n");
  const recorder = createLoadFailureRecorder();
  const result = await Effect.runPromise(
    resolveToolingIncludes({
      appRoot: root,
      sourceRoot: root,
      recorder,
      loadScope: { env: {}, recipe: undefined, recorder },
      landofile: {
        includes: [
          { kind: "tooling", source: "./a.yml", namespace: "tools" },
          { kind: "tooling", source: "./b.yml", namespace: "tools" },
        ],
      },
    }),
  );
  expect(recorder.failures).toHaveLength(1);
  expect(recorder.failures[0]).toMatchObject({ _tag: "LandofileIncludeError", kind: "fetch-failed" });
  expect(result.tooling).toMatchObject({ "tools:shared": "second" });
});

test("does not deduplicate eager failures with the same referenced path at different destinations", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: aggregate\nx-a: \"{{ load('../outside.yml') }}\"\nx-b: \"{{ load('../outside.yml') }}\"\n",
  );
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(
    snapshot.result.violations.filter((issue) => issue.rule === "landofile.load").map((issue) => issue.path),
  ).toEqual([["x-a"], ["x-b"]]);
});
