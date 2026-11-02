import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { valueOriginAt } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { getOrigins } from "../src/pipeline/origins.ts";
import { getSourceDocuments } from "../src/pipeline/source-table.ts";
import { composeLandofileRootLayers, loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-tooling-attribution-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const inputs = () => ({
  ports: makeTestLandofilePorts(root),
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [] },
});
const write = (file: string, content: string) => writeFile(join(root, file), content);
const load = () => loadLandofileLayers(root, join(root, ".lando.yml"), inputs());
const compose = () => composeLandofileRootLayers(root, inputs());
const failure = () => Effect.runPromise(load().pipe(Effect.flip));
const entry = (source: string, namespace?: string) =>
  `  - source: ${source}\n    kind: tooling\n${namespace === undefined ? "" : `    namespace: ${namespace}\n`}`;
const origin = (file: string, layer: "canonical" | "local", path: readonly (string | number)[]) => ({
  file: join(root, file),
  layer,
  path,
});

describe("tooling include attribution", () => {
  test.each([
    {
      name: "outside-root",
      includes: entry("../outside.yml", "docs"),
      fragment: "tooling:\n  task:\n    cmd: echo ok\n",
      kind: "outside-root",
      file: ".lando.yml",
      path: ["includes", 0],
    },
    {
      name: "load",
      includes: entry("./task0.yml", "docs"),
      fragment: "services: {}\n",
      kind: "forbidden-field",
      file: ".lando.yml",
      path: ["includes", 0],
    },
    {
      name: "collision",
      includes: entry("./task0.yml", "docs") + entry("./task0.yml", "docs"),
      fragment: "tooling:\n  task:\n    cmd: echo ok\n",
      kind: "forbidden-field",
      file: ".lando.yml",
      path: ["includes", 1],
    },
    {
      name: "max-depth",
      includes: entry("./task0.yml", "docs"),
      fragment: undefined,
      kind: "max-depth",
      file: "task8.yml",
      path: ["toolingIncludes", "nested"],
    },
  ])("attributes $name failures to the failing entry", async ({ includes, fragment, kind, file, path }) => {
    // Given
    await write(".lando.yml", `name: attribution\nincludes:\n${includes}`);
    for (let index = 0; index < 10; index++)
      await write(
        `task${index}.yml`,
        fragment ?? `toolingIncludes:\n  nested:\n    file: ./task${index + 1}.yml\n`,
      );
    // When
    const error = await failure();
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind,
      ...origin(file, "canonical", path),
    });
  });

  test("composed entries retain authored indices and declaring layers", async () => {
    // Given
    await write(".lando.yml", `name: attribution\nincludes:\n  - ./frag.yml\n${entry("./a.yml", "a")}`);
    await write("frag.yml", `includes:\n${entry("./f.yml", "f")}`);
    await write(
      ".lando.local.yml",
      `includes:\n${entry("./b.yml", "b")}toolingIncludes:\n  c:\n    file: ./c.yml\n`,
    );
    // When
    const { merged } = await Effect.runPromise(compose());
    // Then
    const origins = getOrigins(merged);
    if (origins === undefined) throw new Error("Missing composed origins");
    expect([0, 1, 2].map((index) => valueOriginAt(origins, ["includes", index]).source)).toEqual([
      origin("frag.yml", "canonical", ["includes", 0]),
      origin(".lando.yml", "canonical", ["includes", 1]),
      origin(".lando.local.yml", "local", ["includes", 0]),
    ]);
    expect(valueOriginAt(origins, ["toolingIncludes", "c"]).source).toEqual(
      origin(".lando.local.yml", "local", ["toolingIncludes", "c"]),
    );
  });

  test("tooling fragment source documents use each declaring entry's layer", async () => {
    // Given
    await write(".lando.yml", `name: attribution\nincludes:\n  - ./frag.yml\n${entry("./a.yml", "a")}`);
    await write("frag.yml", `includes:\n${entry("./f.yml", "f")}`);
    await write(
      ".lando.local.yml",
      `includes:\n${entry("./b.yml", "b")}toolingIncludes:\n  c:\n    file: ./c.yml\n`,
    );
    for (const name of ["a", "b", "c", "f"])
      await write(`${name}.yml`, "tooling:\n  task:\n    cmd: echo ok\n");
    // When
    const result = await Effect.runPromise(load());
    // Then
    expect(
      getSourceDocuments(result)
        .filter(({ file }) => /\/[abcf]\.yml$/.test(file))
        .map(({ file, layer }) => [file, layer]),
    ).toEqual([
      [join(root, "f.yml"), "canonical"],
      [join(root, "a.yml"), "canonical"],
      [join(root, "b.yml"), "local"],
      [join(root, "c.yml"), "local"],
    ]);
  });

  for (const scenario of [
    {
      name: "canonical array",
      lintName: "root array",
      file: ".lando.yml",
      layer: "canonical",
      missingConfig: `name: attribution\nincludes:\n  - ./ok.yml\n${entry("./missing.yml", "docs")}`,
      lintConfig: `name: attribution\nincludes:\n${entry("./missing.yml", "docs")}`,
      missingPath: ["includes", 1],
      lintPath: ["includes", 0],
      line: 3,
    },
    {
      name: "local shorthand",
      lintName: "local shorthand",
      file: ".lando.local.yml",
      layer: "local",
      missingConfig: "toolingIncludes:\n  docs:\n    file: ./missing.yml\n",
      lintConfig: "toolingIncludes:\n  docs:\n    file: ./missing.yml\n",
      missingPath: ["toolingIncludes", "docs"],
      lintPath: ["toolingIncludes", "docs"],
      line: 2,
    },
  ] as const) {
    test(`missing ${scenario.name} entry carries provenance`, async () => {
      // Given
      await write(".lando.yml", "name: attribution\n");
      await write(scenario.file, scenario.missingConfig);
      await write("ok.yml", "services: {}\n");
      // When
      const error = await failure();
      // Then
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind: "fetch-failed",
        ...origin(scenario.file, scenario.layer, scenario.missingPath),
      });
    });

    test(`lint reports ${scenario.lintName} entry path and source`, async () => {
      // Given
      await write(".lando.yml", "name: attribution\n");
      await write(scenario.file, scenario.lintConfig);
      // When
      const { result } = await Effect.runPromise(lintLandofileSnapshot({ cwd: root }, inputs()));
      // Then
      const source = origin(scenario.file, scenario.layer, scenario.lintPath);
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.load",
          path: source.path,
          source,
          line: scenario.line,
          column: 3,
        }),
      ]);
    });
  }

  for (const { name, file, kind } of [
    { name: "missing include", file: "missing.yml", kind: "fetch-failed" },
    { name: "cycle", file: "outer.yml", kind: "cycle" },
  ]) {
    test(`nested ${name} keeps innermost entry`, async () => {
      // Given
      await write(".lando.yml", "name: attribution\n");
      await write(".lando.local.yml", "toolingIncludes:\n  outer:\n    file: ./outer.yml\n");
      await write("outer.yml", `toolingIncludes:\n  nested:\n    file: ./${file}\n`);
      // When
      const error = await failure();
      // Then
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind,
        ...origin("outer.yml", "local", ["toolingIncludes", "nested"]),
      });
    });
  }

  for (const { name, includes } of [
    { name: "missing namespace", includes: entry("./missing.yml") },
    { name: "transport field", includes: `${entry("./missing.yml", "docs")}    version: main\n` },
  ]) {
    test(`${name} failure points to its entry`, async () => {
      // Given
      await write(".lando.yml", `name: attribution\nincludes:\n${includes}`);
      // When
      const error = await failure();
      // Then
      expect(error).toMatchObject({
        _tag: "LandofileIncludeError",
        kind: "forbidden-field",
        ...origin(".lando.yml", "canonical", ["includes", 0]),
      });
    });
  }

  for (const { directive, config, tasks, layer } of [
    {
      directive: "!override",
      config: `includes: !override\n${entry("./b.yml", "b")}`,
      tasks: ["b:task"],
      layer: "local" as const,
    },
    { directive: "!reset", config: "includes: !reset\n", tasks: [], layer: undefined },
  ]) {
    test(`${directive} resets composed tooling membership without relocating origins`, async () => {
      // Given
      await write(
        ".lando.yml",
        `name: attribution\nincludes:\n  - ./frag.yml\n${entry("./missing.yml", "a")}`,
      );
      await write("frag.yml", `includes:\n${entry("./also-missing.yml", "f")}`);
      await write(".lando.local.yml", config);
      await write("b.yml", "tooling:\n  task:\n    cmd: echo ok\n");
      // When
      const result = await Effect.runPromise(load());
      // Then
      expect(Object.keys(result.document.tooling ?? {})).toEqual(tasks);
      expect(getSourceDocuments(result).find(({ file }) => file === join(root, "b.yml"))?.layer).toBe(layer);
    });
  }

  test("single-over-single redirects source while inheriting flags and field origins", async () => {
    // Given
    await write(
      ".lando.yml",
      `name: attribution\nincludes:\n${entry("./a.yml", "docs")}    internal: true\n    optional: true\n    aliases: [other]\n    excludes: [skip]\n    vars:\n      mode: inherited\n`,
    );
    await write(".lando.local.yml", `includes:\n${entry("./b.yml", "docs")}`);
    // When
    const { merged } = await Effect.runPromise(compose());
    // Then
    expect(merged.includes).toMatchObject([
      {
        source: "./b.yml",
        namespace: "docs",
        internal: true,
        optional: true,
        aliases: ["other"],
        excludes: ["skip"],
        vars: { mode: "inherited" },
      },
    ]);
    const origins = getOrigins(merged);
    if (origins === undefined) throw new Error("Missing composed origins");
    expect(valueOriginAt(origins, ["includes", 0]).source).toEqual(
      origin(".lando.local.yml", "local", ["includes", 0]),
    );
    expect(valueOriginAt(origins, ["includes", 0, "internal"]).source).toEqual(
      origin(".lando.yml", "canonical", ["includes", 0, "internal"]),
    );
  });

  test("redirected source failures belong to the higher-layer entry", async () => {
    // Given
    await write(
      ".lando.yml",
      `name: attribution\nincludes:\n${entry("./a.yml", "docs")}    internal: true\n`,
    );
    await write(".lando.local.yml", `includes:\n${entry("./missing.yml", "docs")}`);
    // When
    const error = await failure();
    // Then
    expect(error).toMatchObject({
      _tag: "LandofileIncludeError",
      kind: "fetch-failed",
      ...origin(".lando.local.yml", "local", ["includes", 0]),
    });
  });

  test("identical source strings retain distinct namespaces and layer provenance", async () => {
    // Given
    await write(".lando.yml", `name: attribution\nincludes:\n${entry("./tasks.yml", "a")}`);
    await write(".lando.local.yml", `includes:\n${entry("./tasks.yml", "b")}`);
    await write("tasks.yml", "tooling:\n  task:\n    cmd: echo ok\n");
    // When
    const result = await Effect.runPromise(load());
    // Then
    expect(Object.keys(result.document.tooling ?? {})).toEqual(["a:task", "b:task"]);
    expect(
      getSourceDocuments(result)
        .filter(({ file }) => file === join(root, "tasks.yml"))
        .map(({ layer }) => layer),
    ).toEqual(["canonical", "local"]);
  });
});
