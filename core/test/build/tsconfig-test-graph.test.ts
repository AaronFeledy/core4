import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("aggregate test tsconfig graph", () => {
  test("excludes gitignored generated guide scenarios from tsc -b", async () => {
    // Given: the root aggregate test project that `bun run typecheck` references.
    const tsconfig: unknown = await Bun.file(resolve(repoRoot, "tsconfig.test.json")).json();

    // When: its include/exclude lists are inspected.
    // Then: generated guide tests stay out of the composite program after codegen.
    expect(tsconfig).toMatchObject({
      include: expect.arrayContaining(["./test/**/*.ts"]),
      exclude: expect.arrayContaining(["./test/scenarios/generated/**"]),
    });
  });
});
