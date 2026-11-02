import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { loadLandofileLayers } from "../src/service.ts";
import { authoredRecipe } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-conditional-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const inputs = (env: Readonly<Record<string, string>> = {}) => ({
  ports: makeTestLandofilePorts(join(root, "cache")),
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [], context: { env, scope: "test", bootstrapLevel: "minimal" as const } },
});
const load = (env: Readonly<Record<string, string>> = {}) =>
  Effect.runPromise(loadLandofileLayers(root, join(root, ".lando.yml"), inputs(env)));

test.each(["landofile", "compose", "tooling"] as const)(
  "when false skips a missing %s fragment before acquisition (#1569 QA20)",
  async (kind) => {
    await writeFile(
      join(root, ".lando.yml"),
      emitLandofileYaml({
        name: "conditional",
        includes: [
          { source: "./absent.yml", kind, when: false, ...(kind === "tooling" ? { namespace: "docs" } : {}) },
        ],
      }),
    );
    const compiled = await load();
    expect(compiled.document.name).toBe("conditional");
    expect(compiled.pendingSites).toEqual([]);
  },
);

test("an env flip changes the next composed result without retaining the condition site (#1569 QA27)", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: conditional\nincludes:\n  - source: ./cache.yml\n    when: \"{{ boolean(default(env.CACHE_ENABLED, '0')) }}\"\n",
  );
  await writeFile(join(root, "cache.yml"), "services:\n  cache:\n    image: redis:7\n");
  const enabled = await load({ CACHE_ENABLED: "1" });
  const disabled = await load({ CACHE_ENABLED: "0" });
  expect(Object.keys(enabled.document.services ?? {})).toEqual(["cache"]);
  expect(Object.keys(disabled.document.services ?? {})).toEqual([]);
  expect(enabled.pendingSites).toEqual([]);
  expect(disabled.pendingSites).toEqual([]);
});

test.each(["redis", "none"])(
  "reads the recipe option from a higher root layer: %s (#1569 QA22)",
  async (cache) => {
    await writeFile(
      join(root, ".lando.yml"),
      emitLandofileYaml({
        name: "conditional",
        recipe: authoredRecipe({ cache: "none" }),
        includes: [{ source: "./cache.yml", when: "{{ recipe.cache == 'redis' }}" }],
      }),
    );
    await writeFile(join(root, ".lando.local.yml"), `recipe:\n  options:\n    cache: ${cache}\n`);
    await writeFile(join(root, "cache.yml"), "services:\n  cache:\n    image: redis:7\n");
    const compiled = await load();
    expect(Object.keys(compiled.document.services ?? {})).toEqual(cache === "redis" ? ["cache"] : []);
  },
);

test.each(["github:missing/does-not-exist", "npm:@missing/does-not-exist"])(
  "disabled %s needs neither acquisition nor cache or pins (#1569 QA23)",
  async (source) => {
    await writeFile(
      join(root, ".lando.yml"),
      emitLandofileYaml({ name: "conditional", includes: [{ source, path: "fragment.yml", when: false }] }),
    );
    const compiled = await load();
    expect(compiled.document.name).toBe("conditional");
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
    expect(await Bun.file(join(root, "cache")).exists()).toBe(false);
  },
);

test.each([
  '"{{ env.HOME }}"',
  '"{{ env.MISSING }}"',
  '"{{ boolean(env.MISSING) }}"',
  '"{{ app.name }}"',
  '"prefix {{ true }}"',
  '"true"',
])("attributes an invalid condition %s to its authored when site (#1569 QA24)", async (when) => {
  await writeFile(
    join(root, ".lando.yml"),
    `name: conditional\nincludes:\n  - source: ./absent.yml\n    when: ${when}\n`,
  );
  const snapshot = await Effect.runPromise(
    lintLandofileSnapshot({ cwd: root }, inputs({ HOME: "/home/example" })),
  );
  expect(snapshot.result.valid).toBe(false);
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.load")).toMatchObject([
    {
      path: ["includes", 0, "when"],
      source: { file: join(root, ".lando.yml"), layer: "canonical", path: ["includes", 0, "when"] },
    },
  ]);
});

test.each(["canonical", "shorthand"])(
  "prunes disabled %s tooling before unresolved vars (#1569 QA25)",
  async (form) => {
    const include =
      form === "canonical"
        ? 'includes:\n  - kind: tooling\n    source: ./absent.yml\n    namespace: docs\n    when: "{{ false }}"\n    vars:\n      VALUE: "{{ env.MISSING }}"\n'
        : 'toolingIncludes:\n  docs:\n    file: ./absent.yml\n    when: "{{ false }}"\n    vars:\n      VALUE: "{{ env.MISSING }}"\n';
    await writeFile(join(root, ".lando.yml"), `name: conditional\n${include}`);
    const compiled = await load();
    expect(Object.keys(compiled.document.tooling ?? {})).toEqual([]);
    expect(compiled.pendingSites).toEqual([]);
  },
);

test("an inactive include does not execute eager expressions in its other fields", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    'name: conditional\nincludes:\n  - source: "{{ load(\'./absent-source.yml\') }}"\n    kind: tooling\n    namespace: docs\n    when: "{{ false }}"\n    vars:\n      VALUE: "{{ load(\'./absent-var.yml\') }}"\n',
  );
  const compiled = await load();
  expect(compiled.document.name).toBe("conditional");
  expect(compiled.pendingSites).toEqual([]);
});

test("disabled nested tooling is pruned before materializing its vars", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: conditional\ntoolingIncludes:\n  tools:\n    file: ./tools.yml\n",
  );
  await writeFile(
    join(root, "tools.yml"),
    'toolingIncludes:\n  disabled:\n    file: ./absent.yml\n    when: "{{ false }}"\n    vars:\n      VALUE: "{{ env.MISSING }}"\ntooling:\n  hello: echo hello\n',
  );
  const compiled = await load();
  expect(Object.keys(compiled.document.tooling ?? {})).toEqual(["tools:hello"]);
  expect(compiled.pendingSites).toEqual([]);
});

test("keeps conditional failure paths in the declaring layer after pruning earlier entries", async () => {
  await writeFile(join(root, ".lando.yml"), "name: conditional\n");
  await writeFile(
    join(root, ".lando.local.yml"),
    'includes:\n  - source: ./skipped.yml\n    when: false\n  - source: ./absent.yml\n    when: "{{ env.MISSING }}"\ntoolingIncludes:\n  docs:\n    file: ./absent-tools.yml\n    when: "{{ env.MISSING }}"\n',
  );
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(snapshot.result.violations.filter((issue) => issue.rule === "landofile.load")).toMatchObject([
    {
      path: ["includes", 1, "when"],
      source: { file: join(root, ".lando.local.yml"), layer: "local", path: ["includes", 1, "when"] },
    },
    {
      path: ["toolingIncludes", "docs", "when"],
      source: {
        file: join(root, ".lando.local.yml"),
        layer: "local",
        path: ["toolingIncludes", "docs", "when"],
      },
    },
  ]);
});

test.each(["docs.v2", "123"])(
  "keeps tooling namespace %s atomic in a condition failure path",
  async (namespace) => {
    await writeFile(
      join(root, ".lando.yml"),
      emitLandofileYaml({
        name: "conditional",
        toolingIncludes: { [namespace]: { file: "./absent.yml", when: "{{ env.MISSING }}" } },
      }),
    );
    const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
    expect(
      snapshot.result.violations
        .filter((issue) => issue.rule === "landofile.load")
        .map((issue) => issue.path),
    ).toEqual([["toolingIncludes", namespace, "when"]]);
  },
);

test("keeps the inherited layer when the same fragment has a condition failure in two layers", async () => {
  await writeFile(join(root, ".lando.yml"), "name: conditional\nincludes: [./shared.yml]\n");
  await writeFile(join(root, ".lando.local.yml"), "includes: [./shared.yml]\n");
  await writeFile(
    join(root, "shared.yml"),
    'toolingIncludes:\n  docs:\n    file: ./absent.yml\n    when: "{{ env.MISSING }}"\n',
  );
  const snapshot = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
  expect(
    snapshot.result.violations
      .filter((issue) => issue.rule === "landofile.load")
      .map((issue) => issue.source),
  ).toEqual([
    { file: join(root, "shared.yml"), layer: "canonical", path: ["toolingIncludes", "docs", "when"] },
    { file: join(root, "shared.yml"), layer: "local", path: ["toolingIncludes", "docs", "when"] },
  ]);
});

test("pruning a disabled tooling entry preserves a whole-map override", async () => {
  await writeFile(
    join(root, ".lando.yml"),
    "name: conditional\ntoolingIncludes:\n  inherited:\n    file: ./base-tools.yml\n",
  );
  await writeFile(join(root, "base-tools.yml"), "tooling:\n  hello: echo hello\n");
  await writeFile(
    join(root, ".lando.local.yml"),
    "toolingIncludes: !override\n  disabled:\n    file: ./absent.yml\n    when: false\n",
  );
  const compiled = await load();
  expect(Object.keys(compiled.document.tooling ?? {})).toEqual([]);
});
