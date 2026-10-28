import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAILS_GEMFILE } from "../../src/recipes/builtin/rails/scaffold.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";
import { externalRecipeSource, externalRecipeYaml } from "./fixtures/external-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "external-origins-")));
  roots.push(root);
  return {
    root,
    recipe: join(root, "external"),
    options: {
      cwd: root,
      full: false,
      name: "origin-app",
      destination: join(root, "app"),
      nonInteractive: true,
      userDataRoot: join(root, "data"),
    },
  };
};

test("inherited files and scripts read their declaring parent rather than child shadows", async () => {
  // Given
  const { root, recipe, options } = await fixture();
  const child = externalRecipeSource();
  await Bun.write(
    join(root, "parent/recipe.yml"),
    "id: parent\ntitle: Parent\ndescription: Parent\nversion: 1.0.0\nconfig:\n  runtime: 4\nfiles:\n  - src: asset.txt\n    dest: notice.txt\npostInit:\n  - type: bun\n    verb: script\n    script: assets/setup.ts\n",
  );
  await Bun.write(join(root, "parent/asset.txt"), "parent bytes");
  await Bun.write(join(root, "parent/assets/setup.ts"), "export {};\n");
  await Bun.write(join(recipe, "asset.txt"), "child shadow");
  await Bun.write(join(recipe, "assets/setup.ts"), "throw new Error('child shadow');\n");
  await Bun.write(join(recipe, "recipe.yml"), `${externalRecipeYaml(child)}extends: ../parent\n`);
  const commands: ReadonlyArray<string>[] = [];
  // When
  const result = await initApp({
    ...options,
    recipe,
    postInitSpawner: {
      spawn: async ({ cmd }) => {
        commands.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  // Then
  expect(await Bun.file(join(result.directory, "notice.txt")).text()).toBe("parent bytes");
  expect(commands.some((cmd) => cmd.includes(join(root, "parent/assets/setup.ts")))).toBe(true);
});

test("explicit bundled parent assets retain the bundled declaring origin", async () => {
  // Given
  const { recipe, options } = await fixture();
  const child = externalRecipeSource();
  await Bun.write(join(recipe, "Gemfile"), "child shadow");
  await Bun.write(join(recipe, "recipe.yml"), `${externalRecipeYaml(child)}extends: rails\n`);
  // When
  const result = await initApp({ ...options, recipe, runPostInit: false });
  // Then
  expect(await Bun.file(join(result.directory, "Gemfile")).text()).toBe(RAILS_GEMFILE);
});

test("remote initial local-parent hop is jailed to its published acquisition root", async () => {
  // Given
  const { root, options } = await fixture();
  await Bun.write(
    join(root, "parent/recipe.yml"),
    "id: parent\ntitle: Parent\ndescription: Parent\nversion: 1.0.0\nconfig:\n  runtime: 4\n",
  );
  // When / Then
  await expect(
    initApp({
      ...options,
      source: "git",
      url: "https://example.test/r.git",
      gitRecipeCloner: {
        clone: async ({ stagingDir }) => {
          await Bun.write(
            join(stagingDir, "recipe.yml"),
            `id: external\ntitle: External\ndescription: Jailed\nversion: 1.0.0\nconfig:\n  runtime: 4\nextends: ${join(root, "parent")}\n`,
          );
          return { commitSha: "a".repeat(40) };
        },
      },
    }),
  ).rejects.toMatchObject({ _tag: "RecipeExtendsError", kind: "parent-not-found" });
});

test("remote initial local-parent hop never executes recipe.ts", async () => {
  // Given
  const { options } = await fixture();
  // When / Then
  await expect(
    initApp({
      ...options,
      source: "git",
      url: "https://example.test/r.git",
      gitRecipeCloner: {
        clone: async ({ stagingDir }) => {
          await Bun.write(
            join(stagingDir, "recipe.yml"),
            "id: external\ntitle: External\ndescription: Jailed\nversion: 1.0.0\nconfig:\n  runtime: 4\nextends: ./parent\n",
          );
          await Bun.write(join(stagingDir, "parent/recipe.ts"), "throw new Error('must not run');");
          return { commitSha: "b".repeat(40) };
        },
      },
    }),
  ).rejects.toMatchObject({
    _tag: "RecipeManifestValidationError",
    source: expect.stringContaining("parent"),
  });
});

test("remote subpath can inherit YAML siblings within the published acquisition root", async () => {
  // Given
  const { options } = await fixture();
  const child = externalRecipeYaml(externalRecipeSource());
  // When
  const result = await initApp({
    ...options,
    source: "git",
    path: "recipes/external",
    url: "https://example.test/r.git",
    gitRecipeCloner: {
      clone: async ({ stagingDir }) => {
        await Bun.write(join(stagingDir, "recipes/external/recipe.yml"), `${child}extends: ../parent\n`);
        await Bun.write(
          join(stagingDir, "recipes/parent/recipe.yml"),
          "id: parent\ntitle: Parent\ndescription: Parent\nversion: 1.0.0\nconfig:\n  runtime: 4\n",
        );
        return { commitSha: "c".repeat(40) };
      },
    },
  });
  // Then
  expect(await Bun.file(join(result.directory, ".lando.yml")).text()).toContain("alpine:3.21");
});
