import { relative, resolve } from "node:path";

import { expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const wrapperPath = resolve(repoRoot, "scripts/build-compiled-binary.ts");

const productionSources = async (): Promise<ReadonlyArray<string>> => {
  const paths = [resolve(repoRoot, "core/package.json")];
  for (const pattern of ["scripts/**/*.ts", "core/test/**/*.ts", ".github/workflows/*.{yml,yaml}"]) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: repoRoot, absolute: true })) {
      paths.push(path);
    }
  }
  return paths.sort();
};

test("release-shaped main binary compiles use the compiled binary wrapper", async () => {
  // Given: every production script, package command, and generated workflow.
  const offenders: Array<string> = [];

  // When: release-shaped shell and programmatic main-binary compiles are located.
  for (const path of await productionSources()) {
    const source = await Bun.file(path).text();
    const hasBareShellCompile =
      /bun build[^\n]*(?:\.\/core\/bin\/lando\.ts|\.\/bin\/lando\.ts)[^\n]*--compile/u.test(source) ||
      /bun build[^\n]*--compile[^\n]*(?:\.\/core\/bin\/lando\.ts|\.\/bin\/lando\.ts)/u.test(source) ||
      /["']build["']\s*,\s*(?:binaryEntry|["']\.?\/?core\/bin\/lando\.ts["'])[\s\S]{0,300}["']--compile["']/u.test(
        source,
      );
    const hasProgrammaticMainCompile =
      path !== wrapperPath &&
      /Bun\.build\s*\([\s\S]{0,1200}core\/bin\/lando\.ts[\s\S]{0,1200}compile/u.test(source);
    if (hasBareShellCompile || hasProgrammaticMainCompile) offenders.push(relative(repoRoot, path));
  }

  // Then: the wrapper is the only release-shaped main compile boundary.
  expect(offenders).toEqual([]);
});
