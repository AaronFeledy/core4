import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { lintLandofile } from "../../src/landofile/lint.ts";

describe("lintLandofile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lando-lint-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lint = (cwd: string) => Effect.runPromiseExit(lintLandofile({ cwd }));

  const write = async (content: string) => writeFile(join(dir, ".lando.yml"), content, "utf8");

  test("a valid Landofile lints clean", async () => {
    await write("name: myapp\nrecipe: lamp\n");
    const exit = await lint(dir);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.valid).toBe(true);
      expect(exit.value.violations).toHaveLength(0);
      expect(exit.value.app).toBe("myapp");
      expect(exit.value.file.endsWith(".lando.yml")).toBe(true);
    }
  });

  test("an unknown top-level key is reported as a structured violation (schema-only, no scanner error)", async () => {
    await write("name: myapp\nbogusKey: nope\n");
    const exit = await lint(dir);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.valid).toBe(false);
      expect(exit.value.violations.length).toBeGreaterThan(0);
      const v = exit.value.violations[0];
      expect(typeof v?.path).toBe("string");
      expect(typeof v?.message).toBe("string");
      expect(v?.path).toContain("bogusKey");
      expect(v?.suggestedFix).toBeDefined();
    }
  });

  test("a wrong-typed value is reported as a violation with a path", async () => {
    await write("name: myapp\nruntime: 3\n");
    const exit = await lint(dir);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.valid).toBe(false);
      expect(exit.value.violations.some((v) => v.path.includes("runtime"))).toBe(true);
    }
  });

  test("a malformed YAML file folds into a violation (valid:false), not a hard crash", async () => {
    await write(":\n  - broken\n::::\n");
    const exit = await lint(dir);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.valid).toBe(false);
      expect(exit.value.violations.length).toBeGreaterThan(0);
    }
  });

  test("a missing Landofile fails with LandofileNotFoundError", async () => {
    const exit = await lint(dir);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause;
      expect(JSON.stringify(failure)).toContain("LandofileNotFoundError");
    }
  });
});
