import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cause, Effect, Exit } from "effect";

import {
  NotImplementedError,
  RecipeManifestNotFoundError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";

import { resolveRecipeRef } from "../../src/recipes/source.ts";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-recipe-ts-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runResolve = async (ref: string, cwd: string) => Effect.runPromiseExit(resolveRecipeRef(ref, { cwd }));

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveRecipeRef — programmatic recipe.ts (§8.8.14)", () => {
  test("committed recipe.ts (defineRecipe + Recipe type) loads with prompts/runs/fetchAllowlist/postInit", async () => {
    const recipeDir = join(FIXTURE_ROOT, "programmatic-recipe");
    const exit = await runResolve(recipeDir, FIXTURE_ROOT);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const { manifest, source, root, manifestYaml } = exit.value;
    expect(source).toBe(join(recipeDir, "recipe.ts"));
    expect(root).toBe(recipeDir);
    expect(manifestYaml).toBe("");
    expect(manifest).toBeDefined();
    expect(manifest?.id).toBe("programmatic-recipe");
    expect(manifest?.runs).toEqual(["composer", "npm"]);
    expect(manifest?.fetchAllowlist).toEqual(["https://api.example.com/**"]);
    expect(manifest?.prompts?.map((p) => p.name)).toEqual(["name", "phpVersion"]);
    expect(manifest?.postInit?.map((a) => a.type)).toEqual(["bun", "message"]);
  });

  test("async factory recipe.ts resolves to a validated manifest", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "factory-recipe");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          "export default async () => ({",
          '  id: "factory-recipe",',
          '  title: "Factory Recipe",',
          '  description: "Built by an async factory.",',
          '  version: "0.1.0",',
          '  runs: ["git"],',
          '  prompts: [{ name: "name", type: "text", message: "App name?" }],',
          '  files: [{ src: "a", dest: ".lando.yml" }],',
          '  postInit: [{ type: "gitInit" }],',
          "});",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./factory-recipe", dir);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.manifest?.id).toBe("factory-recipe");
      expect(exit.value.manifest?.runs).toEqual(["git"]);
    });
  });

  test("invalid recipe.ts shape (missing required version) fails with RecipeManifestValidationError", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "bad-recipe");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        ['export default { id: "bad-recipe", title: "Bad", description: "No version." };', ""].join("\n"),
      );
      const exit = await runResolve("./bad-recipe", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestValidationError);
      if (failure instanceof RecipeManifestValidationError) {
        expect(failure.source).toBe(join(recipeDir, "recipe.ts"));
        expect(failure.message).toContain("recipe.ts is invalid");
        expect(failure.message).not.toContain("recipe.yml is invalid");
      }
    });
  });

  test("recipe.ts id mismatching directory basename fails with RecipeManifestValidationError", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "expected-id");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          "export default {",
          '  id: "wrong-id",',
          '  title: "Mismatch",',
          '  description: "id does not match directory basename.",',
          '  version: "0.0.1",',
          "};",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./expected-id", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestValidationError);
      if (failure instanceof RecipeManifestValidationError) {
        expect(failure.message).toContain('"wrong-id"');
        expect(failure.message).toContain('"expected-id"');
      }
    });
  });

  test("recipe.ts semantic validation errors use the TypeScript file label", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "missing-choices");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          "export default {",
          '  id: "missing-choices",',
          '  title: "Missing choices",',
          '  description: "select prompt without choices.",',
          '  version: "0.0.1",',
          "  prompts: [",
          '    { name: "framework", type: "select", message: "Framework?" },',
          "  ],",
          "};",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./missing-choices", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestValidationError);
      if (failure instanceof RecipeManifestValidationError) {
        expect(failure.source).toBe(join(recipeDir, "recipe.ts"));
        expect(failure.message).toContain("recipe.ts is invalid");
        expect(failure.message).not.toContain("recipe.yml is invalid");
        expect(failure.issues.some((issue) => issue.includes("framework") && issue.includes("choices"))).toBe(
          true,
        );
      }
    });
  });

  test("a directory carrying both recipe.yml and recipe.ts is rejected (mutually exclusive)", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "both");
      await Bun.write(
        join(recipeDir, "recipe.yml"),
        ["id: both", "title: Both", "description: Two forms.", "version: 0.0.1", ""].join("\n"),
      );
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          'export default { id: "both", title: "Both", description: "Two forms.", version: "0.0.1" };',
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./both", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestValidationError);
      if (failure instanceof RecipeManifestValidationError) {
        expect(failure.message).toContain("one or the other");
        expect(failure.issues.join(" ")).toContain("mutually exclusive");
      }
    });
  });

  test("recipe.ts with no default export fails with RecipeManifestParseError", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "no-default");
      await Bun.write(join(recipeDir, "recipe.ts"), ["export const recipe = {};", ""].join("\n"));
      const exit = await runResolve("./no-default", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestParseError);
      if (failure instanceof RecipeManifestParseError) {
        expect(failure.message).toContain("default export");
      }
    });
  });

  test("recipe.ts is held to the same Beta-rejection pipeline as recipe.yml (unsupported bun verb)", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "beta-verb");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          "export default {",
          '  id: "beta-verb",',
          '  title: "Beta verb",',
          '  description: "Uses a deferred bun verb.",',
          '  version: "0.0.1",',
          '  postInit: [{ type: "bun", verb: "add" }],',
          "};",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./beta-verb", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(NotImplementedError);
    });
  });

  test("a directory with neither recipe.yml nor recipe.ts fails with RecipeManifestNotFoundError", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "empty-recipe");
      await Bun.write(join(recipeDir, ".keep"), "");
      const exit = await runResolve("./empty-recipe", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestNotFoundError);
      if (failure instanceof RecipeManifestNotFoundError) {
        expect(failure.message).toContain("recipe.ts");
      }
    });
  });

  test("syntactically invalid recipe.ts surfaces a parse error, not a disallowed-import error", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "broken-recipe");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        ["export default {", '  id: "broken-recipe",', "  this is not valid typescript <<<", ""].join("\n"),
      );
      const exit = await runResolve("./broken-recipe", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestParseError);
      if (failure instanceof RecipeManifestParseError) {
        expect(failure.message).toContain("could not be parsed");
        expect(failure.message).not.toContain("disallowed import");
      }
    });
  });

  test('recipe.ts require("parse") is reported as disallowed require(), not a TS parse failure', async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "require-parse");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          'const parser = require("parse");',
          "export default {",
          '  id: "require-parse",',
          '  title: "Require Parse",',
          '  description: "Uses require with a sentinel-like package name.",',
          '  version: "0.0.1",',
          "};",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./require-parse", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestParseError);
      if (failure instanceof RecipeManifestParseError) {
        expect(failure.message).toContain("disallowed import");
        expect(failure.message).toContain("parse");
        expect(failure.message).not.toContain("could not be parsed");
      }
    });
  });

  test("recipe.ts importing a forbidden node built-in is rejected", async () => {
    await withTempCwd(async (dir) => {
      const recipeDir = join(dir, "shell-recipe");
      await Bun.write(
        join(recipeDir, "recipe.ts"),
        [
          'import { execSync } from "node:child_process";',
          "export default {",
          '  id: "shell-recipe",',
          '  title: "Shell",',
          '  description: "Tries to shell out.",',
          '  version: "0.0.1",',
          "};",
          "",
        ].join("\n"),
      );
      const exit = await runResolve("./shell-recipe", dir);
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeManifestParseError);
      if (failure instanceof RecipeManifestParseError) {
        expect(failure.message).toContain("disallowed import");
      }
    });
  });
});
