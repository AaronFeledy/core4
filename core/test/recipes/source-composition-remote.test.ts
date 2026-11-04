import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGitTransport } from "@lando/source-acquisition/git";
import { Effect } from "effect";
import { resolveGitRecipeSource } from "../../src/recipes/git-source";
import { resolveRecipeSource } from "../../src/recipes/resolved-source";
import { makeTestProcessRunner, withRecipeSources } from "../_support/recipe-source-session.ts";

// Top-level keys must start at column 0 after `config:` so they are siblings, not nested.
const yaml = (id: string, extra = "") =>
  `id: ${id}\ntitle: ${id}\ndescription: Remote fixture\nversion: 1.0.0\nconfig:\n  runtime: 4\n${extra}`;

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

test("retains repository-wide acquisition evidence when a remote child inherits sibling YAML", async () => {
  await withRepository(async (root, repo) => {
    await Bun.write(join(repo, "child/recipe.yml"), yaml("child", "extends: ../parent\n"));
    await Bun.write(
      join(repo, "parent/recipe.yml"),
      yaml("parent", "files:\n  - src: asset\n    dest: asset\n"),
    );
    await Bun.write(join(repo, "parent/asset"), "from-parent");
    await git(repo, ["add", "."]);
    await git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    await withRecipeSources(
      {
        root: join(root, "sources"),
        git: makeGitTransport(makeTestProcessRunner()),
      },
      async ({ session }) => {
        const acquired = await resolveGitRecipeSource({
          url: repo,
          path: "child",
          sources: session,
        });
        const resolution = await Effect.runPromise(resolveRecipeSource(acquired, { sources: session }));
        expect(resolution.sources.map(({ value }) => value.id)).toEqual(["parent", "child"]);
        expect(resolution.sources.map(({ evidence }) => evidence.transport)).toEqual([
          { kind: "git", commit: acquired.commitSha },
          { kind: "git", commit: acquired.commitSha },
        ]);
        expect(resolution.files[0]?.origin).toMatchObject({
          kind: "directory",
          acquisitionRoot: acquired.acquisitionRoot,
        });
      },
    );
  });
});

for (const hop of ["initial", "subsequent"] as const) {
  test(`rejects a host parent escape on the ${hop} remote hop`, async () => {
    await withRepository(async (root, repo) => {
      const outside = join(root, "outside");
      await mkdir(outside, { recursive: true });
      await Bun.write(join(outside, "recipe.yml"), yaml("outside"));
      await Bun.write(
        join(repo, "child/recipe.yml"),
        yaml("child", `extends: ${hop === "initial" ? outside : "../parent"}\n`),
      );
      await Bun.write(join(repo, "parent/recipe.yml"), yaml("parent", `extends: ${outside}\n`));
      await git(repo, ["add", "."]);
      await git(repo, ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
      await withRecipeSources(
        {
          root: join(root, "sources"),
          git: makeGitTransport(makeTestProcessRunner()),
        },
        async ({ session }) => {
          const acquired = await resolveGitRecipeSource({
            url: repo,
            path: "child",
            sources: session,
          });
          await expect(
            Effect.runPromise(resolveRecipeSource(acquired, { sources: session })),
          ).rejects.toBeTruthy();
        },
      );
    });
  });
}
