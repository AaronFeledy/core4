import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit } from "effect";

import type { GitRecipeCloner } from "../../src/recipes/git-source.ts";
import { flattenRecipe } from "../../src/recipes/manifest/flatten.ts";
import { parseRecipeYaml } from "../../src/recipes/manifest/parser.ts";
import { parseRecipe, validateRecipeManifestObject } from "../../src/recipes/manifest/service.ts";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

const runParse = async (source: string, content: string) =>
  Effect.runPromiseExit(parseRecipe(source, content));

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

const parseFixture = async (id: string) => {
  const source = join(FIXTURE_ROOT, id, "recipe.yml");
  return runParse(source, await Bun.file(source).text());
};

const flattenThenValidate = (source: string, parsed: unknown, ctx?: Parameters<typeof flattenRecipe>[2]) =>
  flattenRecipe(source, parsed, ctx).pipe(
    Effect.flatMap((flat) => validateRecipeManifestObject(source, flat)),
  );

const hopNames = (error: unknown): ReadonlyArray<string> => {
  if (error === null || typeof error !== "object" || !("chain" in error) || !Array.isArray(error.chain)) {
    return [];
  }
  return error.chain.map(String);
};

const PARENT_RECIPE = `id: remote-parent
title: Remote Parent
description: A git sourced parent recipe.
version: 0.1.0
prompts:
  - name: from-parent
    type: text
    message: Parent prompt
    default: parent-default
`;

const CHILD_YAML = `id: remote-child
title: Remote Child
description: Extends a git parent.
version: 0.2.0
extends: git+https://example.test/parent.git
prompts:
  - name: from-child
    type: text
    message: Child prompt
    default: child-default
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-extends-git-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const makeCloner = (
  options: {
    readonly commitSha?: string;
    readonly manifest?: string;
    readonly extraFiles?: ReadonlyArray<{ readonly path: string; readonly contents: string }>;
    readonly extraSymlinks?: ReadonlyArray<{ readonly path: string; readonly target: string }>;
    readonly calls?: Array<{ readonly url: string; readonly stagingDir: string }>;
  } = {},
): GitRecipeCloner => ({
  clone: async ({ url, stagingDir }) => {
    options.calls?.push({ url, stagingDir });
    await mkdir(stagingDir, { recursive: true });
    if (options.manifest !== undefined) await writeFile(join(stagingDir, "recipe.yml"), options.manifest);
    for (const file of options.extraFiles ?? []) {
      await mkdir(dirname(join(stagingDir, file.path)), { recursive: true });
      await writeFile(join(stagingDir, file.path), file.contents);
    }
    for (const link of options.extraSymlinks ?? []) {
      await mkdir(dirname(join(stagingDir, link.path)), { recursive: true });
      await symlink(link.target, join(stagingDir, link.path));
    }
    return { commitSha: options.commitSha ?? "abc123def456" };
  },
});

describe("parseRecipe — recipe composition", () => {
  test("given a child that extends lamp, when parseRecipe flattens it, then prompts files and postInit merge and extends is gone", async () => {
    const exit = await parseFixture("extends-lamp-child");
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const manifest = exit.value;
    expect(manifest.id).toBe("extends-lamp-child");
    expect(manifest.prompts?.some((prompt) => prompt.name === "name")).toBe(true);
    expect(manifest.prompts?.find((prompt) => prompt.name === "php")?.default).toBe("8.2");
    expect(manifest.files?.map((file) => file.dest)).toEqual(
      expect.arrayContaining([".lando.yml", "extra.txt"]),
    );
    expect(manifest.postInit?.map((action) => action.type)).toEqual(
      expect.arrayContaining(["message", "gitInit"]),
    );
    expect("extends" in manifest).toBe(false);
    expect(manifest.prompts?.some((prompt) => "drop" in prompt)).toBe(false);
    expect(manifest.files?.some((file) => "drop" in file)).toBe(false);
    expect(manifest.postInit?.some((action) => "drop" in action)).toBe(false);
  });

  test("given drop true on a lamp prompt by name, when parseRecipe flattens the child, then that prompt is gone", async () => {
    const exit = await parseFixture("extends-drop-child");
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.prompts?.some((prompt) => prompt.name === "name")).toBe(false);
    expect(exit.value.prompts?.some((prompt) => prompt.name === "php")).toBe(true);
    expect(exit.value.prompts?.some((prompt) => "drop" in prompt)).toBe(false);
  });

  test("given a child that omits tags while the parent has tags, when parseRecipe flattens it, then the result has no tags", async () => {
    const exit = await parseFixture("extends-lamp-child");
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.tags).toBeUndefined();
  });

  test("given a three-hop chain A to B to C to D, when parseRecipe flattens the child, then it succeeds", async () => {
    const exit = await parseFixture("extends-a");
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.prompts?.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(["from-a", "from-b", "from-c", "from-d"]),
    );
    expect("extends" in exit.value).toBe(false);
  });

  test("given a four-hop chain, when parseRecipe runs, then it fails RecipeExtendsError kind depth naming every hop", async () => {
    const exit = await parseFixture("extends-e");
    const error = expectFailure(exit);
    expect(error).toMatchObject({ _tag: "RecipeExtendsError", kind: "depth" });
    const hops = hopNames(error);
    expect(hops.some((hop) => hop.includes("extends-e"))).toBe(true);
    expect(hops.some((hop) => hop.includes("extends-a"))).toBe(true);
    expect(hops.some((hop) => hop.includes("extends-b"))).toBe(true);
    expect(hops.some((hop) => hop.includes("extends-c"))).toBe(true);
    expect(hops.some((hop) => hop.includes("extends-d"))).toBe(true);
  });

  test("given a cyclic extends chain, when parseRecipe runs, then it fails RecipeExtendsError kind cycle including the loop", async () => {
    const exit = await parseFixture("extends-cycle-a");
    const error = expectFailure(exit);
    expect(error).toMatchObject({ _tag: "RecipeExtendsError", kind: "cycle" });
    const hops = hopNames(error);
    expect(hops.some((hop) => hop.includes("extends-cycle-a"))).toBe(true);
    expect(hops.some((hop) => hop.includes("extends-cycle-b"))).toBe(true);
  });

  test("given a missing parent, when parseRecipe runs, then it fails RecipeExtendsError kind parent-not-found", async () => {
    const yaml = `id: extends-missing
title: Missing parent
description: Extends a recipe that does not exist.
version: 0.0.1
extends: definitely-not-a-recipe
`;
    const exit = await runParse("test://extends-missing", yaml);
    const error = expectFailure(exit);
    expect(error).toMatchObject({ _tag: "RecipeExtendsError", kind: "parent-not-found" });
  });

  test("given a child YAML with extends lamp, when parseRecipe runs, then the result is a valid flattened RecipeManifest", async () => {
    const source = join(FIXTURE_ROOT, "extends-lamp-child", "recipe.yml");
    const exit = await runParse(source, await Bun.file(source).text());
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.id).toBe("extends-lamp-child");
    expect(exit.value.title).toBe("Lamp Child");
    expect(exit.value.version).toBe("0.2.0");
    expect("extends" in exit.value).toBe(false);
  });
});

describe("flattenRecipe — remote git parent", () => {
  test("given child YAML extends git+https, when flatten runs twice, then parent merges and cloner is called once", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const calls: Array<{ readonly url: string; readonly stagingDir: string }> = [];
      const gitRecipeCloner = makeCloner({
        calls,
        manifest: PARENT_RECIPE,
        commitSha: "feedface",
      });
      const parsed = await Effect.runPromise(
        parseRecipeYaml({ source: "test://remote-child", content: CHILD_YAML }),
      );
      const ctx = { userDataRoot, gitRecipeCloner };

      const first = await Effect.runPromiseExit(flattenThenValidate("test://remote-child", parsed, ctx));
      expect(Exit.isSuccess(first)).toBe(true);
      if (!Exit.isSuccess(first)) return;
      expect(first.value.id).toBe("remote-child");
      expect(first.value.prompts?.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(["from-parent", "from-child"]),
      );
      expect("extends" in first.value).toBe(false);
      expect(
        await Bun.file(join(userDataRoot, "recipe-cache", "git", "feedface", "recipe.yml")).exists(),
      ).toBe(true);

      const second = await Effect.runPromiseExit(flattenThenValidate("test://remote-child", parsed, ctx));
      expect(Exit.isSuccess(second)).toBe(true);
      if (!Exit.isSuccess(second)) return;
      expect(second.value.id).toBe("remote-child");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.test/parent.git");
    });
  });

  test("given a remote parent that extends a sibling YAML, when flatten runs, then the in-tree YAML merges", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const gitRecipeCloner = makeCloner({
        manifest: `id: remote-parent
title: Remote Parent
description: Extends a sibling YAML recipe.
version: 0.1.0
extends: ./hook
`,
        extraFiles: [
          {
            path: "hook/recipe.yml",
            contents: `id: hook
title: Hook
description: In-tree YAML parent.
version: 0.1.0
prompts:
  - name: from-hook
    type: text
    message: Hook prompt
    default: hook-default
`,
          },
        ],
        commitSha: "cafef00d",
      });
      const parsed = await Effect.runPromise(
        parseRecipeYaml({ source: "test://remote-child", content: CHILD_YAML }),
      );
      const exit = await Effect.runPromiseExit(
        flattenThenValidate("test://remote-child", parsed, { userDataRoot, gitRecipeCloner }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      expect(exit.value.prompts?.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(["from-hook", "from-child"]),
      );
    });
  });

  test("given a remote parent that extends sibling recipe.ts, when flatten runs, then recipe.ts is not executed", async () => {
    await withTempRoot(async (dir) => {
      const marker = join(dir, "executed");
      const userDataRoot = join(dir, "data");
      const gitRecipeCloner = makeCloner({
        manifest: `id: remote-parent
title: Remote Parent
description: Tries to execute sibling recipe.ts.
version: 0.1.0
extends: ./hook
`,
        extraFiles: [
          {
            path: "hook/recipe.ts",
            contents: [
              "export default async () => {",
              `  await Bun.write(${JSON.stringify(marker)}, "pwned");`,
              "  return {",
              '    id: "hook",',
              '    title: "Hook",',
              '    description: "Should not run.",',
              '    version: "0.1.0",',
              "  };",
              "};",
              "",
            ].join("\n"),
          },
        ],
        commitSha: "deadbeef",
      });
      const parsed = await Effect.runPromise(
        parseRecipeYaml({ source: "test://remote-child", content: CHILD_YAML }),
      );
      const exit = await Effect.runPromiseExit(
        flattenThenValidate("test://remote-child", parsed, { userDataRoot, gitRecipeCloner }),
      );
      const error = expectFailure(exit);
      expect(error).toMatchObject({ _tag: "RecipeManifestValidationError" });
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });

  test("given a remote parent that extends a host-absolute path, when flatten runs, then the hop is rejected", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const gitRecipeCloner = makeCloner({
        manifest: `id: remote-parent
title: Remote Parent
description: Tries to escape the published tree.
version: 0.1.0
extends: ~/not-a-recipe
`,
        commitSha: "baddcafe",
      });
      const parsed = await Effect.runPromise(
        parseRecipeYaml({ source: "test://remote-child", content: CHILD_YAML }),
      );
      const exit = await Effect.runPromiseExit(
        flattenThenValidate("test://remote-child", parsed, { userDataRoot, gitRecipeCloner }),
      );
      const error = expectFailure(exit);
      expect(error).toMatchObject({ _tag: "RecipeExtendsError", kind: "parent-not-found" });
    });
  });
  test("given a remote parent whose local hop is a symlink out of the cache, when flatten runs, then the hop is rejected", async () => {
    await withTempRoot(async (dir) => {
      const outside = join(dir, "outside");
      await mkdir(outside);
      await writeFile(
        join(outside, "recipe.yml"),
        [
          "id: escaped",
          "title: Escaped",
          "description: Host YAML reached through a symlink.",
          "version: 0.1.0",
          "prompts:",
          "  - name: from-outside",
          "    type: text",
          "    message: Should not merge",
          "",
        ].join("\n"),
      );
      const userDataRoot = join(dir, "data");
      const gitRecipeCloner = makeCloner({
        manifest: `id: remote-parent
title: Remote Parent
description: Ships a symlink parent hop.
version: 0.1.0
extends: ./hook
`,
        extraSymlinks: [{ path: "hook", target: outside }],
        commitSha: "symlink1",
      });
      const parsed = await Effect.runPromise(
        parseRecipeYaml({ source: "test://remote-child", content: CHILD_YAML }),
      );
      const exit = await Effect.runPromiseExit(
        flattenThenValidate("test://remote-child", parsed, { userDataRoot, gitRecipeCloner }),
      );
      const error = expectFailure(exit);
      expect(error).toMatchObject({ _tag: "RecipeExtendsError", kind: "parent-not-found" });
    });
  });
});
