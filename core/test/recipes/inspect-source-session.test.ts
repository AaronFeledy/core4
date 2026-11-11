import { expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PathsService, ProcessRunner, StateStore } from "@lando/sdk/services";
import {
  disposeTestSourceStore,
  makeTestProcessRunner,
  makeTestSourceStore,
} from "@lando/source-acquisition/testing";
import { Effect } from "effect";
import { recipesDescribe, recipesValidate } from "../../src/cli/commands/recipes.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";
import { startGitHttpServer } from "../_support/git-http-server.ts";

const yaml = (id: string, extra = "") =>
  `id: ${id}\ntitle: ${id}\ndescription: Fixture\nversion: 1.0.0\nconfig:\n  runtime: 4\n${extra}`;

test.each(["describe", "validate", "parse"] as const)("%s leases remote parents", async (mode) => {
  const fixture = await makeTestSourceStore();
  const root = dirname(fixture.root);
  const server = startGitHttpServer(root);
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const runner = makeTestProcessRunner();
    const git = async (args: readonly string[]) => {
      const result = await Effect.runPromise(
        runner.run({
          cmd: "git",
          args,
          cwd: repo,
          env: {
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          },
        }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
    };
    await git(["init", "-q"]);
    await writeFile(join(repo, "recipe.yml"), yaml("remote-parent"));
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    await git(["clone", "--bare", ".", join(root, "parent.git")]);
    const child = join(root, "child");
    await mkdir(child);
    const content = yaml("child", `extends: git+${server.url("parent.git")}\n`);
    await writeFile(join(child, "recipe.yml"), content);
    const operation = Effect.gen(function* () {
      switch (mode) {
        case "describe":
          return (yield* recipesDescribe(child, { cwd: root })).id;
        case "validate":
          return (yield* recipesValidate(child, { cwd: root })).id;
        case "parse":
          return (yield* parseRecipe(join(child, "recipe.yml"), content)).id;
        default: {
          const exhaustive: never = mode;
          return exhaustive;
        }
      }
    });

    const result = await Effect.runPromise(
      operation.pipe(
        Effect.provideService(StateStore, fixture.stateStore),
        Effect.provideService(PathsService, makeLandoPaths({ userCacheRoot: root })),
        Effect.provideService(ProcessRunner, runner),
      ),
    );
    expect(result).toBe("child");
    expect(await readdir(join(fixture.root, ".leases"))).toEqual([]);
    expect(server.requests.some((request) => request.path.startsWith("/parent.git/"))).toBe(true);
  } finally {
    await server.stop();
    await disposeTestSourceStore(fixture);
  }
});
