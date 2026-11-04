import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { makeGitTransport } from "../src/git.ts";
import { makeTestProcessRunner, withTestSources } from "../src/testing.ts";
import { makeBareGitRepo } from "./support.ts";

test("checkout preserves blob bytes despite attributes, smudge filters, templates, and global hooks", async () => {
  const repo = await makeBareGitRepo({
    ".gitattributes": "* text eol=crlf\n*.txt filter=demo ident\n",
    "payload.txt": "first\n$Id$\nlast\n",
  });
  const temp = await mkdtemp(join(tmpdir(), "lando-git-checkout-"));
  const marker = join(temp, "executed");
  const template = join(temp, "template");
  const hooks = join(temp, "hooks");
  await mkdir(join(template, "hooks"), { recursive: true });
  await mkdir(hooks);
  const script = `#!/bin/sh\nprintf executed > '${marker}'\n`;
  await writeFile(join(template, "hooks", "post-checkout"), script, { mode: 0o700 });
  await writeFile(join(hooks, "post-checkout"), script, { mode: 0o700 });
  const base = makeTestProcessRunner();
  const runner = {
    ...base,
    run: (input: Parameters<typeof base.run>[0]) =>
      base.run({
        ...input,
        env: {
          ...input.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TEMPLATE_DIR: template,
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "filter.demo.smudge",
          GIT_CONFIG_VALUE_0: `sh -c "printf filter > '${marker}'; cat"`,
          GIT_CONFIG_KEY_1: "core.hooksPath",
          GIT_CONFIG_VALUE_1: hooks,
        },
      }),
  };
  try {
    const blob = await Effect.runPromise(
      base.run({ cmd: "git", args: ["-C", repo.bare, "show", "HEAD:payload.txt"], capture: true }),
    );
    expect(blob.exitCode).toBe(0);
    expect(blob.stdout).toBe("first\n$Id$\nlast\n");
    await withTestSources({ git: makeGitTransport(runner) }, ({ session }) =>
      Effect.gen(function* () {
        const snapshot = yield* session.acquireGit({ url: repo.bare, ref: "main" });
        const bytes = yield* Effect.promise(() => readFile(join(snapshot.root, "payload.txt"), "utf8"));
        expect(bytes).toBe(blob.stdout);
      }),
    );
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await rm(temp, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("ls-remote resolves HEAD, branches, exact refs, and peeled tags while declining ambiguous short names", async () => {
  const repo = await makeBareGitRepo();
  const runner = makeTestProcessRunner();
  const run = async (args: readonly string[]) => {
    const result = await Effect.runPromise(
      runner.run({
        cmd: "git",
        args: ["-C", repo.bare, ...args],
        capture: true,
        env: { GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.test" },
      }),
    );
    expect(result.exitCode).toBe(0);
  };
  try {
    await run(["tag", "-a", "release", "-m", "annotated"]);
    await run(["branch", "release"]);
    const resolve = makeGitTransport(runner).resolve;
    expect(resolve).toBeDefined();
    if (resolve === undefined) throw new Error("git transport must resolve refs");
    expect(await resolve({ url: repo.bare })).toBe(repo.commit);
    expect(await resolve({ url: repo.bare, ref: "main" })).toBe(repo.commit);
    expect(await resolve({ url: repo.bare, ref: "refs/tags/release" })).toBe(repo.commit);
    expect(await resolve({ url: repo.bare, ref: "refs/heads/release" })).toBe(repo.commit);
    expect(await resolve({ url: repo.bare, ref: "release" })).toBeUndefined();
    expect(await resolve({ url: repo.bare, ref: "missing" })).toBeUndefined();
    await run(["tag", "-a", "tag-only", "-m", "annotated"]);
    expect(await resolve({ url: repo.bare, ref: "tag-only" })).toBe(repo.commit);
  } finally {
    await repo.cleanup();
  }
});
