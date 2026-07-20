import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkImportCycle } from "../../../scripts/check-import-cycle.ts";
import { scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

let root: string;

const write = async (path: string, contents: string): Promise<void> => {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents);
};

const writePackage = async (
  directory: string,
  name: string,
  exports: string | Readonly<Record<string, string | Readonly<Record<string, string>>>>,
): Promise<void> => {
  await write(`${directory}/package.json`, `${JSON.stringify({ name, exports })}\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "import-cycle-"));
  await Promise.all([
    writePackage("core", "@lando/core", "./src/index.ts"),
    writePackage("sdk", "@lando/sdk", {
      ".": "./src/index.ts",
      "./feature": { types: "./src/feature-types.ts", import: "./src/feature.ts" },
    }),
    writePackage("container-runtime", "@lando/container-runtime", "./src/index.ts"),
    writePackage("plugins/example", "@lando/example", {
      ".": { types: "./src/index.ts", import: "./src/index.ts" },
    }),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("module edge type-only classification", () => {
  test("classifies whole declarations and per-specifier type forms", () => {
    // Given
    const source = [
      'import type { A } from "./a.ts";',
      'import { type B } from "./b.ts";',
      'import { type C, value } from "./c.ts";',
      'export type { D } from "./d.ts";',
      'export { type E } from "./e.ts";',
      'export { type F, value as other } from "./f.ts";',
    ].join("\n");

    // When
    const edges = scanModuleEdges("fixture.ts", source);

    // Then
    expect(edges.map(({ specifier, typeOnly }) => [specifier, typeOnly])).toEqual([
      ["./a.ts", true],
      ["./b.ts", true],
      ["./c.ts", false],
      ["./d.ts", true],
      ["./e.ts", true],
      ["./f.ts", false],
    ]);
  });
});

describe("check-import-cycle", () => {
  test("reports deterministic cycles for every runtime edge form", async () => {
    // Given
    await Promise.all([
      write("core/src/a.ts", 'import { b } from "./b";\nexport const a = b;\n'),
      write("core/src/b.ts", 'export { a } from "./a.ts";\nexport const b = 1;\n'),
      write("core/src/self.ts", 'import "./self.ts";\n'),
      write("core/src/dynamic.ts", 'void import("@lando/sdk/feature");\n'),
      write("sdk/src/feature.ts", 'require("@lando/core/dynamic");\n'),
      write(
        "core/package.json",
        `${JSON.stringify({
          name: "@lando/core",
          exports: {
            ".": "./src/index.ts",
            "./dynamic": { types: "./src/dynamic-types.ts", import: "./src/dynamic.ts" },
          },
        })}\n`,
      ),
    ]);

    // When
    const result = await checkImportCycle({ root });

    // Then
    expect(result.ok).toBe(false);
    expect(result.cycles.map((cycle) => cycle.modules)).toEqual([
      ["core/src/a.ts", "core/src/b.ts"],
      ["core/src/dynamic.ts", "sdk/src/feature.ts"],
      ["core/src/self.ts"],
    ]);
    expect(result.cycles[0]?.edges).toEqual([
      { from: "core/src/a.ts", to: "core/src/b.ts", line: 1, specifier: "./b" },
      { from: "core/src/b.ts", to: "core/src/a.ts", line: 1, specifier: "./a.ts" },
    ]);
  });

  test("ignores cycles made only from erased type edges", async () => {
    // Given
    await Promise.all([
      write("core/src/types-a.ts", 'import type { B } from "./types-b.ts";\nexport type A = B;\n'),
      write("core/src/types-b.ts", 'export { type A } from "./types-a.ts";\nexport type B = A;\n'),
      write("sdk/src/index.ts", 'export type * from "@lando/core";\n'),
      write("core/src/index.ts", 'import { type Sdk } from "@lando/sdk";\nexport type Core = Sdk;\n'),
    ]);

    // When
    const result = await checkImportCycle({ root });

    // Then
    expect(result.ok).toBe(true);
    expect(result.cycles).toEqual([]);
  });

  test("scans generated source but excludes tests and non-source directories", async () => {
    // Given
    await Promise.all([
      write("plugins/example/src/generated/a.ts", 'import "../b.ts";\n'),
      write("plugins/example/src/b.ts", 'import "./generated/a.ts";\n'),
      write("core/src/ignored.test.ts", 'import "./ignored.test.ts";\n'),
      write("core/test/not-source.ts", 'import "./not-source.ts";\n'),
    ]);

    // When
    const result = await checkImportCycle({ root });

    // Then
    expect(result.cycles.map((cycle) => cycle.modules)).toEqual([
      ["plugins/example/src/b.ts", "plugins/example/src/generated/a.ts"],
    ]);
  });

  test("resolves main-only workspace roots and extensionless mts directories", async () => {
    // Given
    await Promise.all([
      write(
        "core/package.json",
        `${JSON.stringify({
          name: "@lando/core",
          exports: { ".": "./src/index.ts", "./legacy": "./src/legacy.ts" },
        })}\n`,
      ),
      write(
        "plugins/legacy/package.json",
        `${JSON.stringify({
          name: "@lando/legacy",
          main: "./src/index.ts",
          types: "./src/index.ts",
        })}\n`,
      ),
      write("core/src/legacy.ts", 'import "@lando/legacy";\n'),
      write("plugins/legacy/src/index.ts", 'import "@lando/core/legacy";\n'),
      write("core/src/directory-entry.ts", 'import "./directory";\n'),
      write("core/src/directory/index.mts", 'import "../directory-entry.ts";\n'),
    ]);

    // When
    const result = await checkImportCycle({ root });

    // Then
    expect(result.cycles.map((cycle) => cycle.modules)).toEqual([
      ["core/src/directory-entry.ts", "core/src/directory/index.mts"],
      ["core/src/legacy.ts", "plugins/legacy/src/index.ts"],
    ]);
  });

  test("scans the real production source graph deterministically", async () => {
    // Given
    const repositoryRoot = join(import.meta.dirname, "../../..");

    // When
    const first = await checkImportCycle({ root: repositoryRoot });
    const second = await checkImportCycle({ root: repositoryRoot });

    // Then
    expect(first.filesScanned).toBeGreaterThan(800);
    expect(second).toEqual(first);
  });
});
