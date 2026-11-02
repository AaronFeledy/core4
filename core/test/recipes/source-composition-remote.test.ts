import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { resolveGitRecipeSource } from "../../src/recipes/git-source";
import { resolveRecipeSource } from "../../src/recipes/resolved-source";

const yaml = (id: string, extra = "") =>
  `id: ${id}\ntitle: ${id}\ndescription: Remote fixture\nversion: 1.0.0\nconfig:\n${extra}`;

const git = async (cwd: string, args: readonly string[]) => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
};

const withRepository = async (run: (root: string, repo: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "recipe-remote-composition-")));
  const repo = join(root, "repo");
  try {
    await mkdir(repo);
    await git(repo, ["init", "-q"]);
    await run(root, repo);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const acquire = async (root: string, repo: string) => {
  await git(repo, ["add", "."]);
  await git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
  return resolveGitRecipeSource({ url: repo, path: "child", userDataRoot: join(root, "data") });
};

test("retains repository-wide acquisition evidence when a remote child inherits sibling YAML", async () => {
  await withRepository(async (root, repo) => {
    await Bun.write(join(repo, "child/recipe.yml"), yaml("child", "extends: ../parent\n"));
    await Bun.write(
      join(repo, "parent/recipe.yml"),
      yaml("parent", "files:\n  - src: asset\n    dest: asset\n"),
    );
    await Bun.write(join(repo, "parent/asset"), "from-parent");
    const acquired = await acquire(root, repo);
    const resolution = await Effect.runPromise(resolveRecipeSource(acquired));
    expect(resolution.sources.map(({ value }) => value.id)).toEqual(["parent", "child"]);
    expect(resolution.sources.map(({ evidence }) => evidence.transport)).toEqual([
      { kind: "git", commit: acquired.commitSha },
      { kind: "git", commit: acquired.commitSha },
    ]);
    expect(resolution.files[0]?.origin).toEqual({
      kind: "directory",
      root: join(root, "data", "recipe-cache", "git", acquired.commitSha, "parent"),
      acquisitionRoot: join(root, "data", "recipe-cache", "git", acquired.commitSha),
    });
  });
});

for (const hop of ["initial", "subsequent"] as const) {
  test(`rejects a host parent escape on the ${hop} remote hop`, async () => {
    await withRepository(async (root, repo) => {
      const outside = join(root, "outside");
      await Bun.write(join(outside, "recipe.yml"), yaml("outside"));
      await Bun.write(
        join(repo, "child/recipe.yml"),
        yaml("child", `extends: ${hop === "initial" ? outside : "../parent"}\n`),
      );
      await Bun.write(join(repo, "parent/recipe.yml"), yaml("parent", `extends: ${outside}\n`));
      const acquired = await acquire(root, repo);
      await expect(Effect.runPromise(resolveRecipeSource(acquired))).rejects.toMatchObject({
        _tag: "RecipeExtendsError",
        kind: "parent-not-found",
      });
    });
  });

  test(`never evaluates TypeScript on the ${hop} remote hop`, async () => {
    await withRepository(async (root, repo) => {
      const marker = join(root, "executed");
      await Bun.write(join(repo, "child/recipe.yml"), yaml("child", "extends: ../parent\n"));
      if (hop === "subsequent")
        await Bun.write(join(repo, "parent/recipe.yml"), yaml("parent", "extends: ../hook\n"));
      const target = hop === "initial" ? "parent" : "hook";
      await Bun.write(
        join(repo, target, "recipe.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {};`,
      );
      const acquired = await acquire(root, repo);
      await expect(Effect.runPromise(resolveRecipeSource(acquired))).rejects.toMatchObject({
        _tag: "RecipeManifestValidationError",
      });
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });
}

for (const kind of ["asset", "script"] as const) {
  test(`rejects an inherited ${kind} symlink outside the acquired tree`, async () => {
    await withRepository(async (root, repo) => {
      const outside = join(root, "outside");
      await Bun.write(outside, "foreign");
      await Bun.write(join(repo, "child/recipe.yml"), yaml("child", "extends: ../parent\n"));
      const declaration =
        kind === "asset"
          ? "files:\n  - src: escape\n    dest: file\n"
          : "postInit:\n  - type: bun\n    verb: script\n    script: escape\n";
      await Bun.write(join(repo, "parent/recipe.yml"), yaml("parent", declaration));
      await symlink(outside, join(repo, "parent/escape"));
      const acquired = await acquire(root, repo);
      await expect(Effect.runPromise(resolveRecipeSource(acquired))).rejects.toMatchObject({
        _tag: "RecipeManifestValidationError",
      });
    });
  });
}

for (const attack of ["escape", "typescript"] as const) {
  test(`keeps the new jail and YAML-only policy after a second remote acquisition (${attack})`, async () => {
    await withRepository(async (root, repo) => {
      const other = join(root, "other");
      const marker = join(root, "executed");
      await mkdir(other);
      await git(other, ["init", "-q"]);
      await Bun.write(join(root, "outside/recipe.yml"), yaml("outside"));
      await Bun.write(
        join(other, "recipe.yml"),
        yaml("other", `extends: ${attack === "escape" ? join(root, "outside") : "./hook"}\n`),
      );
      await Bun.write(
        join(other, "hook/recipe.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {};`,
      );
      await git(other, ["add", "."]);
      await git(other, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
      await Bun.write(join(repo, "child/recipe.yml"), yaml("child", `extends: git+file://${other}\n`));
      const acquired = await acquire(root, repo);
      await expect(
        Effect.runPromise(resolveRecipeSource(acquired, { userDataRoot: join(root, "data") })),
      ).rejects.toMatchObject({
        _tag: attack === "escape" ? "RecipeExtendsError" : "RecipeManifestValidationError",
      });
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });
}
