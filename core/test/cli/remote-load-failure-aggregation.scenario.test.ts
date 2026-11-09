import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startGitHttpServer } from "../_support/git-http-server.ts";
import { createGitRepository } from "../_support/git-repository.ts";
import { lastEnvelope, makeFixture, runSource } from "./subprocess-support.ts";

test("start aggregates a real git ref failure with a missing local include without publishing pins (#1646)", async () => {
  const fixture = await makeFixture("remote-aggregate");
  const server = startGitHttpServer(fixture.root);
  try {
    await createGitRepository(fixture.root, "remote.git", [
      {
        kind: "commit",
        message: "fragment",
        files: { "fragment.yml": "services:\n  web:\n    image: nginx:alpine\n" },
      },
    ]);
    const gitconfig = join(fixture.root, "gitconfig");
    await writeFile(gitconfig, "[protocol]\n version = 2\n[http]\n proxy =\n");
    await writeFile(
      join(fixture.root, ".lando.yml"),
      `name: remote-aggregate\nincludes:\n  - source: ${server.url("remote.git")}\n    path: fragment.yml\n    version: nonexistent-ref-1646\n  - ./missing-local.yml\n`,
    );
    const result = await runSource(
      {
        ...fixture,
        env: {
          ...fixture.env,
          PATH: process.env.PATH ?? "",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_GLOBAL: gitconfig,
        },
      },
      ["start", "--format=json"],
    );
    expect(result.exitCode, result.stderr).toBe(1);
    expect(lastEnvelope(result.stdout)).toMatchObject({
      ok: false,
      error: {
        _tag: "LandofileLoadError",
        message: "Landofile loading failed with 2 problems.",
        failures: [
          { _tag: "LandofileIncludeError", path: ["includes", 0], file: join(fixture.root, ".lando.yml") },
          { _tag: "LandofileIncludeError", path: ["includes", 1], file: join(fixture.root, ".lando.yml") },
        ],
      },
    });
    expect(server.requests.some(({ path }) => path.includes("remote.git"))).toBe(true);
    expect(await Bun.file(join(fixture.root, ".lando.lock.yml")).exists()).toBe(false);
  } finally {
    await server.stop();
    await fixture.cleanup();
  }
}, 30_000);
