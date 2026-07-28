import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import ts from "typescript";

import { getLastRunCacheStats, runRuleSet } from "../../../../scripts/boundary/engine.ts";
import { formatViolation, sortViolations } from "../../../../scripts/boundary/format.ts";
import type { BoundaryRule, RuleScope } from "../../../../scripts/boundary/types.ts";

let root: string;

const write = async (path: string, contents = "export const value = 1;\n"): Promise<void> => {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
};

const makeRule = (
  input: Pick<BoundaryRule, "id" | "scope"> &
    Partial<Pick<BoundaryRule, "carveOuts" | "onNode" | "onEdges" | "onProgram">>,
): BoundaryRule => ({
  carveOuts: { files: [], prefixes: [] },
  passMessage: `${input.id} passed.`,
  failureHeadline: `${input.id} failed.`,
  ...input,
});

const sourceScope = (overrides: Partial<RuleScope> = {}): RuleScope => ({
  roots: ["core/src"],
  extensions: [".ts"],
  ...overrides,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boundary-engine-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("boundary engine", () => {
  test("selects only files admitted by directory, segment, and test exclusions", async () => {
    // Given
    await Promise.all([
      write("core/src/keep.ts"),
      write("core/src/nested/also-keep.ts"),
      write("core/src/skip.test.ts"),
      write("core/src/test/skip.ts"),
      write("core/src/vendor/skip.ts"),
      write("sdk/src/outside.ts"),
    ]);
    const selected: string[] = [];
    const rule = makeRule({
      id: "scope-fixture",
      scope: sourceScope({
        excludeDirNames: ["test"],
        excludePathSegments: ["vendor"],
        excludeTestFiles: true,
      }),
      onNode: (node, context) => {
        if (ts.isSourceFile(node)) selected.push(context.relativePath);
      },
    });

    // When
    await runRuleSet([rule], root);

    // Then
    expect(selected).toEqual(["core/src/keep.ts", "core/src/nested/also-keep.ts"]);
  });

  test("applies exact-file and prefix carve-outs before rule hooks", async () => {
    // Given
    await Promise.all([
      write("core/src/carved.ts"),
      write("core/src/generated/carved.ts"),
      write("core/src/kept.ts"),
    ]);
    const rule = makeRule({
      id: "carve-fixture",
      scope: sourceScope(),
      carveOuts: {
        files: ["core/src/carved.ts"],
        prefixes: ["core/src/generated/"],
      },
      onNode: (node, context) => {
        if (ts.isSourceFile(node)) context.report({ line: 1, detail: "visited" });
      },
    });

    // When
    const results = await runRuleSet([rule], root);

    // Then
    expect(results.get(rule.id)?.violations).toEqual([
      { file: "core/src/kept.ts", line: 1, detail: "visited" },
    ]);
  });

  test("parses a shared file once when two node rules select it", async () => {
    // Given
    await write("core/src/shared.ts", "export const shared = true;\n");
    const first = makeRule({ id: "first", scope: sourceScope(), onNode: () => {} });
    const second = makeRule({ id: "second", scope: sourceScope(), onNode: () => {} });

    // When
    await runRuleSet([first, second], root);

    // Then
    expect(getLastRunCacheStats()).toMatchObject({ parseCount: 1 });
  });

  test("passes shared module-edge scan output to edge rules", async () => {
    // Given
    await write(
      "core/src/edges.ts",
      'import type { Thing } from "./types.ts";\nvoid import("@lando/sdk");\n',
    );
    const observed: Array<readonly [string, boolean]> = [];
    const rule = makeRule({
      id: "edges-fixture",
      scope: sourceScope(),
      onEdges: (edges) => {
        observed.push(...edges.map((edge) => [edge.specifier, edge.typeOnly] as const));
      },
    });

    // When
    await runRuleSet([rule], root);

    // Then
    expect(observed).toEqual([
      ["./types.ts", true],
      ["@lando/sdk", false],
    ]);
  });

  test("lets program rules lazily obtain cached source files", async () => {
    // Given
    await write("core/src/program.ts", "export const programValue = 42;\n");
    let exportedName: string | undefined;
    const rule = makeRule({
      id: "program-fixture",
      scope: sourceScope(),
      onProgram: async (context) => {
        expect(getLastRunCacheStats().parseCount).toBe(0);
        const file = context.files[0];
        if (file === undefined) return;
        const source = await context.sourceFile(file);
        const statement = source.statements[0];
        if (statement !== undefined && ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations[0];
          if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
            exportedName = declaration.name.text;
          }
        }
      },
    });

    // When
    await runRuleSet([rule], root);

    // Then
    expect(exportedName).toBe("programValue");
    expect(getLastRunCacheStats().parseCount).toBe(1);
  });
});

describe("boundary violation formatting", () => {
  test("normalizes separators and sorts by file then line", () => {
    // Given
    const violations = [
      { file: "z\\last.ts", line: 1, detail: "z" },
      { file: "a\\first.ts", line: 8, detail: "later" },
      { file: "a/first.ts", line: 2, detail: "earlier" },
    ];

    // When
    const formatted = sortViolations(violations).map(formatViolation);

    // Then
    expect(formatted).toEqual(["a/first.ts:2: earlier", "a/first.ts:8: later", "z/last.ts:1: z"]);
  });
});
