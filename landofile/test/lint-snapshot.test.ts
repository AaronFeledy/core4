import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { getSourceDocuments } from "../src/pipeline/source-table.ts";
import type { TemplateEngineInputs } from "../src/ports.ts";
import { loadLandofileLayers } from "../src/service.ts";
import * as TsLoader from "../src/ts-loader.ts";
import * as Validation from "../src/validation.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-lint-snapshot-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const write = (file: string, content: string) => writeFile(join(root, file), content);
const lint = () =>
  Effect.runPromise(
    lintLandofileSnapshot(
      { cwd: root },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );

describe("retained lint snapshot", () => {
  test.each([
    {
      declaration:
        "toolingIncludes:\n  frag:\n    file: tasks.yml\n    vars:\n      WHO:\n        sh: echo inc\n",
      path: ["toolingIncludes", "frag", "vars", "WHO"],
      line: 6,
      column: 7,
    },
    {
      declaration:
        "includes:\n  - source: tasks.yml\n    kind: tooling\n    namespace: frag\n    vars:\n      WHO:\n        sh: echo inc\n",
      path: ["includes", 0, "vars", "WHO"],
      line: 7,
      column: 7,
    },
  ])(
    "reports invalid include vars at $path and retains independent fragments (#2212)",
    async ({ declaration, path, line, column }) => {
      await write(".lando.yml", `name: snapshot\n${declaration}`);
      await write(".lando.local.yml", "includes: [good.yml]\n");
      await write("good.yml", "services:\n  web:\n    primary: wrong\n");
      const { result } = await lint();
      expect(result.app).toBe("snapshot");
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rule: "landofile.validation",
            path,
            line,
            column,
            source: { file: join(root, ".lando.yml"), layer: "canonical", path },
          }),
          expect.objectContaining({
            path: ["services", "web", "primary"],
            source: { file: join(root, "good.yml"), layer: "local", path: ["services", "web", "primary"] },
          }),
        ]),
      );
      expect(result.violations).toHaveLength(2);
      const failure = await Effect.runPromise(
        loadLandofileLayers(root, join(root, ".lando.yml"), {
          ports: makeTestLandofilePorts(root),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        }).pipe(Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: "LandofileValidationError",
        issues: [expect.objectContaining({ path })],
      });
    },
  );
  test("reports refused tooling keys once at each authored location (#2211)", async () => {
    await write(
      ".lando.yml",
      [
        "name: snapshot",
        "tooling:",
        "  t:",
        "    cmd: echo hi",
        "    deps: [other]",
        "    vars:",
        "      D:",
        "        default: hi",
        "events:",
        "  pre-start:",
        "    - cmd: echo hi",
        "      platforms: [linux]",
        "",
      ].join("\n"),
    );
    const { result } = await lint();
    expect(result.violations).toEqual([
      expect.objectContaining({
        rule: "landofile.load",
        reason: "NotImplementedError",
        path: ["events", "pre-start", 0, "platforms"],
        line: 12,
        column: 7,
      }),
      expect.objectContaining({
        rule: "landofile.load",
        reason: "NotImplementedError",
        path: ["tooling", "t", "deps"],
        line: 5,
        column: 5,
      }),
      expect.objectContaining({
        rule: "landofile.load",
        reason: "NotImplementedError",
        path: ["tooling", "t", "vars", "D", "default"],
        line: 8,
        column: 9,
        suggestion: "Write the value directly: vars.D: <value>.",
        source: {
          file: join(root, ".lando.yml"),
          layer: "canonical",
          path: ["tooling", "t", "vars", "D", "default"],
        },
      }),
    ]);
  });
  test("reports a refused key from a tooling include once, beside a root refusal", async () => {
    await write(
      ".lando.yml",
      [
        "name: snapshot",
        "tooling:",
        "  t:",
        "    cmd: echo hi",
        "    deps: [other]",
        "toolingIncludes:",
        "  frag:",
        "    file: frag.yml",
        "",
      ].join("\n"),
    );
    await write("frag.yml", ["tooling:", "  u:", "    cmd: echo hi", "    sources: [a]", ""].join("\n"));
    const { result } = await lint();
    expect(result.violations.map((violation) => [violation.reason, violation.path])).toEqual([
      ["NotImplementedError", ["tooling", "t", "deps"]],
      ["NotImplementedError", ["tooling", "u", "sources"]],
    ]);
  });

  test("reports a refused key that a merge directive hides from its fragment, at its effective path", async () => {
    await write(
      ".lando.yml",
      ["name: snapshot", "tooling:", "  t:", "    cmd: echo hi", "    deps: [other]", ""].join("\n"),
    );
    await write(
      ".lando.local.yml",
      ["tooling: !override", "  u:", "    cmd: echo hi", "    sources: [a]", ""].join("\n"),
    );
    const { result } = await lint();
    const refusals = result.violations.filter((violation) => violation.reason === "NotImplementedError");
    expect(refusals.map((violation) => violation.path)).toContainEqual(["tooling", "u", "sources"]);
    expect(new Set(refusals.map((violation) => JSON.stringify(violation.path))).size).toBe(refusals.length);
    expect(result.violations.some((violation) => violation.path.length === 0)).toBe(false);
  });

  test("reports a rejected Compose key once, at its field", async () => {
    await write(
      ".lando.yml",
      "name: snapshot\nservices:\n  web:\n    type: compose\n    image: alpine:3.20\n    container_name: fixed\n",
    );
    const snapshot = await lint();
    expect(snapshot.result.valid).toBe(false);
    expect(snapshot.result.violations.map((violation) => [violation.rule, violation.path])).toEqual([
      ["landofile.compose-rejection", ["services", "web", "container_name"]],
    ]);
  });

  test("reports a rejected key inside a decodable list entry at its field", async () => {
    await write(
      ".lando.yml",
      'name: snapshot\nconfigs:\n  appini:\n    file: ./a.ini\nservices:\n  web:\n    type: compose\n    image: alpine:3.20\n    configs:\n      - source: appini\n        uid: "1000"\n',
    );
    const snapshot = await lint();
    expect(snapshot.result.valid).toBe(false);
    expect(snapshot.result.violations.map((violation) => [violation.rule, violation.path])).toEqual([
      ["landofile.compose-rejection", ["services", "web", "configs", 0, "uid"]],
    ]);
  });

  test("retains a successful resolved object alongside masked fragment findings from includes", async () => {
    await write(
      ".lando.yml",
      "name: snapshot\nincludes: [fragment.yml]\nservices:\n  web:\n    primary: true\n",
    );
    await write("fragment.yml", "services:\n  web:\n    primary: wrong\n");
    const snapshot = await lint();
    expect(snapshot.result.valid).toBe(false);
    expect(snapshot.landofilePath).toBe(join(root, ".lando.yml"));
    expect(snapshot.result.file).toBe(join(root, "fragment.yml"));
    expect(snapshot.resolved?.document.services?.[ServiceName.make("web")]?.primary).toBe(true);
    expect(snapshot.result.violations).toEqual([
      expect.objectContaining({
        scopes: ["fragment"],
        path: ["services", "web", "primary"],
        source: {
          file: join(root, "fragment.yml"),
          layer: "canonical",
          path: ["services", "web", "primary"],
        },
        line: 3,
        column: 5,
      }),
    ]);
    expect(
      snapshot.resolved === undefined
        ? []
        : getSourceDocuments(snapshot.resolved).map((source) => source.file),
    ).toContain(join(root, "fragment.yml"));
  });

  test("keeps authored alias and effective paths distinct at retained-content coordinates", async () => {
    await write(".lando.base.yml", "services:\n  web:\n    working_dir: 5\n");
    await write(".lando.yml", "name: snapshot\n");
    const snapshot = await lint();
    expect(snapshot.result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopes: ["fragment"],
          path: ["services", "web", "working_dir"],
          source: {
            file: join(root, ".lando.base.yml"),
            layer: "base",
            path: ["services", "web", "working_dir"],
          },
          line: 3,
          column: 5,
        }),
        expect.objectContaining({
          scopes: ["effective"],
          path: ["services", "web", "workingDirectory"],
          source: {
            file: join(root, ".lando.base.yml"),
            layer: "base",
            path: ["services", "web", "working_dir"],
          },
          line: 3,
          column: 5,
        }),
      ]),
    );
  });

  test("keeps physical layers distinct while merging the unchanged effective defect", async () => {
    await write(".lando.base.yml", "runtime: wrong\n");
    await write(".lando.yml", "name: snapshot\nruntime: wrong\n");
    const snapshot = await lint();
    const issues = snapshot.result.violations.filter((issue) => issue.path[0] === "runtime");
    expect(issues).toHaveLength(2);
    expect(
      issues.map(({ source, scopes, message }) => ({
        file: source !== undefined && "file" in source ? source.file : undefined,
        scopes,
        message,
      })),
    ).toEqual([
      { file: join(root, ".lando.base.yml"), scopes: ["fragment"], message: "Expected 4" },
      { file: join(root, ".lando.yml"), scopes: ["fragment", "effective"], message: "Expected 4" },
    ]);
  });

  test("evaluates TypeScript and strictly finalizes only once", async () => {
    await write(".lando.ts", 'export default { name: "snapshot", services: { web: { primary: true } } };\n');
    const evaluate = spyOn(TsLoader, "loadLandofileTs");
    const finalize = spyOn(Validation, "validateLandofile");
    try {
      const snapshot = await lint();
      expect(snapshot.result.valid).toBe(true);
      expect(snapshot.resolved?.document.name).toBe("snapshot");
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
      finalize.mockRestore();
    }
  });

  for (const scenario of [
    { name: "runtime input environment", override: false, value: undefined, primary: true },
    { name: "explicit option environment", override: true, value: "option", primary: false },
    { name: "explicit options without an environment", override: true, value: undefined, primary: false },
  ] as const) {
    test(`uses ${scenario.name} during effective lint finalization`, async () => {
      // Given distinct runtime, option and host-default values.
      const key = `ULW_LINT_SCOPE_${crypto.randomUUID().replaceAll("-", "")}`;
      await write(
        ".lando.yml",
        `name: snapshot\nservices:\n  web:\n    primary: "{{ eq(default(env.${key}, 'host'), 'runtime') }}"\n`,
      );
      const templates: TemplateEngineInputs = {
        modules: [],
        ...(scenario.value === undefined
          ? {}
          : { context: { scope: root, bootstrapLevel: "app", env: { [key]: scenario.value } } }),
      };

      // When lint uses the same runtime-input contract as normal loading.
      const snapshot = await Effect.runPromise(
        lintLandofileSnapshot(
          { cwd: root, ...(scenario.override ? { templates } : {}) },
          {
            ports: makeTestLandofilePorts(root),
            stateStore: makeTestLandofileStateStore(),
            templates: {
              modules: [],
              context: { scope: root, bootstrapLevel: "app", env: { [key]: "runtime" } },
            },
          },
        ),
      );

      // Then explicit options win; otherwise the supplied runtime environment wins.
      expect(snapshot.result.valid).toBe(true);
      expect(snapshot.resolved?.document.services?.[ServiceName.make("web")]?.primary).toBe(scenario.primary);
    });
  }
});
