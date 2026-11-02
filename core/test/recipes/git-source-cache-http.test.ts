import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";

import { resolveGitRecipeSource } from "../../src/recipes/git-source.ts";
import { startGitHttpServer } from "../_support/git-http-server.ts";
import { createGitRepository } from "../_support/git-repository.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const FIRST = "id: first\n";
const SECOND = "id: second\n";
const withRepository = async (
  body: (fixture: {
    readonly root: string;
    readonly server: ReturnType<typeof startGitHttpServer>;
    readonly repository: Awaited<ReturnType<typeof createGitRepository>>;
    readonly url: string;
    readonly userDataRoot: string;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-git-cache-http-"));
  const server = startGitHttpServer(root);
  try {
    const repository = await createGitRepository(root, "remote.git", [
      { kind: "commit", files: { "recipe.yml": FIRST }, message: "first" },
      { kind: "git", args: ["tag", "v1"] },
      { kind: "commit", files: { "recipe.yml": SECOND }, message: "second" },
      { kind: "git", args: ["tag", "v2"] },
    ]);
    const config = join(root, "gitconfig");
    await writeFile(config, "[protocol]\n version = 2\n[http]\n proxy =\n");
    await withEnvVar("GIT_CONFIG_NOSYSTEM", "1", () =>
      withEnvVar("GIT_CONFIG_COUNT", "0", () =>
        withEnvVar("GIT_CONFIG_GLOBAL", config, () =>
          body({
            root,
            server,
            repository,
            url: server.url("remote.git"),
            userDataRoot: join(root, "data"),
          }),
        ),
      ),
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
};

describe.skipIf(Bun.which("git") === null)("recipe Git HTTP cache (requires git on PATH)", () => {
  test("keeps separate pointers and contents for two refs at the same URL", async () => {
    // Given
    await withRepository(async ({ url, userDataRoot, repository }) => {
      // When
      const results = await Promise.all(
        ["v1", "v2"].map((ref) => resolveGitRecipeSource({ url, ref, userDataRoot })),
      );

      // Then
      for (const [index, ref] of ["v1", "v2"].entries()) {
        const result = results[index];
        if (result === undefined) throw new Error("Missing acquisition");
        const expectedSha = repository.commits[index];
        if (expectedSha === undefined) throw new Error("Missing fixture commit");
        expect(result.commitSha).toBe(expectedSha);
        expect(await Bun.file(result.source).text()).toBe(index === 0 ? FIRST : SECOND);
        expect(
          await Bun.file(join(userDataRoot, "recipe-cache/git/.url", sha256Hex(`${url}#${ref}`))).text(),
        ).toBe(result.commitSha);
      }
    });
  });

  for (const ref of [undefined, "main", "v2"]) {
    test(`refreshes ${ref ?? "HEAD"} instead of returning a stale pointer`, async () => {
      // Given
      await withRepository(async ({ url, userDataRoot, server, repository }) => {
        const options = { url, userDataRoot, ...(ref === undefined ? {} : { ref }) };
        await resolveGitRecipeSource(options);
        const next = "id: advanced\n";
        const [sha] = await repository.advance([
          { kind: "commit", files: { "recipe.yml": next }, message: "advance" },
          ...(ref === "v2" ? [{ kind: "git" as const, args: ["tag", "-f", "v2"] }] : []),
        ]);
        if (sha === undefined) throw new Error("Missing advanced commit");
        const requests = server.requests.length;

        // When
        const result = await resolveGitRecipeSource(options);

        // Then
        expect(result.commitSha).toBe(sha);
        expect(await Bun.file(result.source).text()).toBe(next);
        expect(server.requests.length).toBeGreaterThan(requests);
      });
    });
  }

  test("reuses a published full SHA offline without a network request", async () => {
    // Given
    await withRepository(async ({ url, userDataRoot, server, repository }) => {
      const ref = repository.commits[0];
      if (ref === undefined) throw new Error("Missing pinned commit");
      await resolveGitRecipeSource({ url, ref: "v1", userDataRoot });
      const requests = server.requests.length;
      await server.stop();

      // When
      const result = await resolveGitRecipeSource({ url, ref, userDataRoot });

      // Then
      expect(result.commitSha).toBe(ref);
      expect(await Bun.file(result.source).text()).toBe(FIRST);
      expect(server.requests).toHaveLength(requests);
    });
  });

  test("falls back to the matching cached ref with a warning when HTTP is offline", async () => {
    // Given
    await withRepository(async ({ url, userDataRoot, server, repository }) => {
      const expectedSha = repository.commits[0];
      if (expectedSha === undefined) throw new Error("Missing fixture commit");
      await resolveGitRecipeSource({ url, ref: "v1", userDataRoot });
      await resolveGitRecipeSource({ url, ref: "v2", userDataRoot });
      await server.stop();
      const warnings: string[] = [];

      // When
      const result = await resolveGitRecipeSource({
        url,
        ref: "v1",
        userDataRoot,
        onWarn: (warning) => {
          warnings.push(warning);
        },
      });

      // Then
      expect(result.commitSha).toBe(expectedSha);
      expect(await Bun.file(result.source).text()).toBe(FIRST);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(url);
      expect(warnings[0]).toContain("v1");
      expect(warnings[0]).toContain(result.commitSha);
    });
  });

  test("fails offline when this ref has no cached pointer", async () => {
    // Given
    await withRepository(async ({ url, userDataRoot, server }) => {
      await resolveGitRecipeSource({ url, ref: "v1", userDataRoot });
      await server.stop();
      const warnings: string[] = [];

      // When
      const acquisition = resolveGitRecipeSource({
        url,
        ref: "v2",
        userDataRoot,
        onWarn: (warning) => {
          warnings.push(warning);
        },
      });

      // Then
      await expect(acquisition).rejects.toMatchObject({ _tag: "RecipeSourceError", kind: "clone-failed" });
      expect(warnings).toEqual([]);
    });
  });

  test("never falls back to cache on an authentication failure", async () => {
    // Given
    await withRepository(async ({ url, userDataRoot }) => {
      await resolveGitRecipeSource({ url, ref: "v1", userDataRoot });
      const warnings: string[] = [];

      // When
      const acquisition = resolveGitRecipeSource({
        url,
        ref: "v1",
        userDataRoot,
        onWarn: (warning) => {
          warnings.push(warning);
        },
        gitRecipeCloner: {
          clone: async () => {
            throw new Error("Authentication failed");
          },
        },
      });

      // Then
      await expect(acquisition).rejects.toMatchObject({ _tag: "RecipeSourceError", kind: "auth" });
      expect(warnings).toEqual([]);
    });
  });
});
