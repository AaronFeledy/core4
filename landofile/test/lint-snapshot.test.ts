import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { getSourceDocuments } from "../src/pipeline/source-table.ts";
import type { TemplateEngineInputs } from "../src/ports.ts";
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
