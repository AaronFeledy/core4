import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultGitRecipeCloner } from "../../src/recipes/git-source.ts";
import { startGitHttpServer } from "../_support/git-http-server.ts";
import { createGitRepository, runFixtureGit } from "../_support/git-repository.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const FIRST = "services: {}\n# first\n";
const MIDDLE = "services: {}\n# non-tip, untagged commit\n";
const TIP = "services: {}\n# default branch tip\n";

const withRepository = async (
  body: (fixture: {
    readonly root: string;
    readonly server: ReturnType<typeof startGitHttpServer>;
    readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-git-http-"));
  const server = startGitHttpServer(root);
  try {
    const repository = await createGitRepository(root, "remote.git", [
      { kind: "commit", files: { "fragment.yml": FIRST }, message: "first" },
      { kind: "git", args: ["tag", "-a", "v1", "-m", "annotated"] },
      { kind: "git", args: ["tag", "v1-lightweight"] },
      { kind: "git", args: ["branch", "release"] },
      { kind: "commit", files: { "fragment.yml": MIDDLE }, message: "middle" },
      { kind: "commit", files: { "fragment.yml": TIP }, message: "tip" },
    ]);
    const config = join(root, "global.gitconfig");
    await writeFile(config, "[core]\n autocrlf = true\n[protocol]\n version = 2\n[http]\n proxy =\n");
    await withEnvVar("GIT_CONFIG_NOSYSTEM", "1", () =>
      withEnvVar("GIT_CONFIG_COUNT", "0", () =>
        withEnvVar("GIT_CONFIG_GLOBAL", config, () => body({ root, server, repository })),
      ),
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
};

describe.skipIf(Bun.which("git") === null)("defaultGitRecipeCloner smart HTTP (requires git on PATH)", () => {
  for (const selection of [
    { name: "annotated tag", ref: "v1", index: 0, bytes: FIRST },
    { name: "lightweight tag", ref: "v1-lightweight", index: 0, bytes: FIRST },
    { name: "branch", ref: "release", index: 0, bytes: FIRST },
    { name: "full non-tip commit SHA via protocol v2", ref: "sha", index: 1, bytes: MIDDLE },
    { name: "default branch when no ref is supplied", ref: undefined, index: 2, bytes: TIP },
  ]) {
    test(`checks out ${selection.name} with LF bytes despite global autocrlf=true`, async () => {
      // Given
      await withRepository(async ({ root, server, repository }) => {
        const expectedSha = repository.commits[selection.index];
        if (expectedSha === undefined) throw new Error("Missing fixture commit");
        const ref = selection.ref === "sha" ? expectedSha : selection.ref;
        const dest = join(root, "acquired");

        // When
        const result = await defaultGitRecipeCloner.clone({
          url: server.url("remote.git"),
          dest,
          stagingDir: dest,
          ...(ref === undefined ? {} : { ref }),
        });

        // Then
        expect(result.commitSha).toBe(expectedSha);
        expect(await Bun.file(join(dest, "fragment.yml")).bytes()).toEqual(
          new TextEncoder().encode(selection.bytes),
        );
        expect(await runFixtureGit(dest, ["rev-parse", "--is-shallow-repository"])).toBe("true");
        expect(server.requests.some((request) => request.method === "POST")).toBe(true);
        expect(server.requests.some((request) => request.protocol === "version=2")).toBe(true);
      });
    });
  }

  for (const selection of ["unknown ref", "abbreviated SHA"] as const) {
    test(`rejects an ${selection} over HTTP`, async () => {
      // Given
      await withRepository(async ({ root, server, repository }) => {
        const first = repository.commits[0];
        if (first === undefined) throw new Error("Missing fixture commit");
        const ref = selection === "unknown ref" ? "absent" : first.slice(0, 8);
        const dest = join(root, "acquired");

        // When
        const acquisition = defaultGitRecipeCloner.clone({
          url: server.url("remote.git"),
          dest,
          stagingDir: dest,
          ref,
        });

        // Then
        await expect(acquisition).rejects.toThrow("couldn't find remote ref");
        expect(server.requests.length).toBeGreaterThan(0);
        expect(await Bun.file(join(dest, "fragment.yml")).exists()).toBe(false);
      });
    });
  }

  test("rejects acquisition when the HTTP server has stopped", async () => {
    // Given
    await withRepository(async ({ root, server }) => {
      const url = server.url("remote.git");
      await server.stop();
      const dest = join(root, "acquired");

      // When
      const acquisition = defaultGitRecipeCloner.clone({ url, dest, stagingDir: dest });

      // Then
      await expect(acquisition).rejects.toThrow(/connect|connection/i);
      expect(server.requests).toHaveLength(0);
      expect(await Bun.file(join(dest, "fragment.yml")).exists()).toBe(false);
    });
  });

  test("acquires newly pushed branch commits from the same HTTP repository", async () => {
    // Given
    await withRepository(async ({ root, server, repository }) => {
      const bytes = "services: {}\n# pushed later\n";
      const [commitSha] = await repository.advance([
        { kind: "commit", files: { "fragment.yml": bytes }, message: "later" },
      ]);
      if (commitSha === undefined) throw new Error("Missing pushed fixture commit");
      const dest = join(root, "acquired");

      // When
      const result = await defaultGitRecipeCloner.clone({
        url: server.url("remote.git"),
        dest,
        stagingDir: dest,
        ref: "main",
      });

      // Then
      expect(result.commitSha).toBe(commitSha);
      expect(await Bun.file(join(dest, "fragment.yml")).bytes()).toEqual(new TextEncoder().encode(bytes));
    });
  });
});
