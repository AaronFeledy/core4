import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SourceAcquisitionError } from "../src/errors.ts";
import { makeGitTransport } from "../src/git.ts";
import {
  disposeTestSourceStore,
  makeTestProcessRunner,
  makeTestSourceStore,
  withTestSession,
  withTestSources,
} from "../src/testing.ts";
import { makeBareGitRepo, makeFakeGitTransport } from "./support.ts";

const FULL_SHA = "a".repeat(40);

describe("makeGitTransport (Bun ProcessRunner)", () => {
  test("floating ref from bare repo strips .git and preserves bytes", async () => {
    const repo = await makeBareGitRepo({
      "readme.txt": "hello-git\n",
      "bin/run.sh": "#!/bin/sh\necho hi\n",
    });
    const destRoot = await mkdtemp(join(tmpdir(), "lando-git-dest-"));
    try {
      const transport = makeGitTransport(makeTestProcessRunner());
      const dest = join(destRoot, "tree");
      const { commit } = await transport.fetch({ url: repo.bare, ref: "main", dest });
      expect(commit).toBe(repo.commit);
      expect(await readFile(join(dest, "readme.txt"), "utf8")).toBe("hello-git\n");
      expect(await readlink(join(dest, "sym-link"))).toBe("sym-target");
      await expect(access(join(dest, ".git"))).rejects.toThrow();
    } finally {
      await rm(destRoot, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  test("exact SHA ref fetch returns that commit", async () => {
    const repo = await makeBareGitRepo({ "a.txt": "a\n" });
    const destRoot = await mkdtemp(join(tmpdir(), "lando-git-sha-"));
    try {
      const transport = makeGitTransport(makeTestProcessRunner());
      const dest = join(destRoot, "tree");
      const { commit } = await transport.fetch({ url: repo.bare, ref: repo.commit, dest });
      expect(commit.toLowerCase()).toBe(repo.commit.toLowerCase());
    } finally {
      await rm(destRoot, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  test("rejects invalid git ref before spawn", async () => {
    const transport = makeGitTransport(makeTestProcessRunner());
    await expect(
      transport.fetch({ url: "/tmp/nope", ref: "feat/../x", dest: "/tmp/out" }),
    ).rejects.toMatchObject({ kind: "invalid-locator" });
  });

  test("unreachable remote is fetch-failed or auth", async () => {
    const destRoot = await mkdtemp(join(tmpdir(), "lando-git-auth-"));
    try {
      const transport = makeGitTransport(makeTestProcessRunner());
      await expect(
        transport.fetch({
          url: "https://127.0.0.1:1/does-not-exist.git",
          ref: "main",
          dest: join(destRoot, "tree"),
        }),
      ).rejects.toBeInstanceOf(SourceAcquisitionError);
    } finally {
      await rm(destRoot, { recursive: true, force: true });
    }
  });
});

describe("SourceSession git acquisition", () => {
  test("floating refs are fetched again even when the last commit is cached", async () => {
    const git = makeFakeGitTransport();
    git.setRef("main", FULL_SHA, { version: "first" });
    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        git.setRef("main", "b".repeat(40), { version: "second" });
        const latest = yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        expect(latest.pin.commit).toBe("b".repeat(40));
        expect(git.calls).toHaveLength(2);
        expect(yield* Effect.promise(() => readFile(join(latest.root, "version"), "utf8"))).toBe("second");
      }),
    );
  });

  test("exact-commit materialization rejects a transport returning another commit", async () => {
    const git = makeFakeGitTransport();
    git.setRef(FULL_SHA, "b".repeat(40), { version: "wrong" });
    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          session.materializeGit({ url: "https://example.test/r.git", commit: FULL_SHA }),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "fetch-failed" } });
        expect(yield* session.openGit("b".repeat(40))).toBeUndefined();
      }),
    );
  });

  test("floating ref acquire publishes tree without .git", async () => {
    const git = makeFakeGitTransport();
    git.setRef("main", FULL_SHA, { "readme.txt": "from-main\n" });

    await withTestSources({ git: git.transport }, ({ session, root }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireGit({ url: "https://example.test/repo.git", ref: "main" });
        expect(snap.key).toEqual({ kind: "git", commit: FULL_SHA });
        expect(yield* Effect.promise(() => readFile(join(snap.root, "readme.txt"), "utf8"))).toBe(
          "from-main\n",
        );
        yield* Effect.promise(() =>
          access(join(snap.root, ".git")).then(
            () => {
              throw new Error("expected missing .git");
            },
            () => undefined,
          ),
        );
        expect(git.calls).toHaveLength(1);
        const opened = yield* session.openGit(FULL_SHA);
        expect(opened?.root).toBe(snap.root);
        // Second acquire of full SHA is cache hit (no transport call)
        const again = yield* session.acquireGit({
          url: "https://example.test/repo.git",
          ref: FULL_SHA,
        });
        expect(again.root).toBe(snap.root);
        expect(git.calls).toHaveLength(1);
        const leases = yield* Effect.promise(() => readdir(join(root, ".leases")));
        expect(leases.length).toBe(1);
      }),
    );
  });

  test("materializeGit exact pin uses cache when warm", async () => {
    const git = makeFakeGitTransport();
    git.setRef(FULL_SHA, FULL_SHA, { "p.txt": "pinned\n" });

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.materializeGit({ url: "https://example.test/r.git", commit: FULL_SHA });
        expect(git.calls).toHaveLength(1);
        yield* session.materializeGit({ url: "https://example.test/r.git", commit: FULL_SHA });
        expect(git.calls).toHaveLength(1);
      }),
    );
  });

  test("stale fallback returns prior commit and invokes callback", async () => {
    const git = makeFakeGitTransport();
    git.setRef("main", FULL_SHA, { "ok.txt": "ok\n" });
    const stale: string[] = [];

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.acquireGit({ url: "https://example.test/stale.git", ref: "main" });
        git.nextError = Object.assign(new Error("network down"), { kind: "fetch-failed" });
        const snap = yield* session.acquireGit(
          { url: "https://example.test/stale.git", ref: "main" },
          { onStaleFallback: (commit) => void stale.push(commit) },
        );
        expect(snap.key).toEqual({ kind: "git", commit: FULL_SHA });
        expect(stale).toEqual([FULL_SHA]);
      }),
    );
  });

  test("auth-tagged transport error preserves auth kind without stale fallback", async () => {
    const git = makeFakeGitTransport();
    git.nextError = Object.assign(new Error("Authentication failed: publickey"), {
      kind: "auth",
    });

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          session.acquireGit(
            { url: "https://example.test/private.git", ref: "main" },
            { onStaleFallback: () => undefined },
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.kind).toBe("auth");
        }
      }),
    );
  });

  test("lease removed when session scope closes", async () => {
    const git = makeFakeGitTransport();
    git.setRef("main", FULL_SHA, { "x.txt": "x\n" });
    const fixture = await makeTestSourceStore({ git: git.transport });
    try {
      await Effect.runPromise(
        withTestSession(fixture.store, (session) =>
          Effect.gen(function* () {
            yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
            const leases = yield* Effect.promise(() => readdir(join(fixture.root, ".leases")));
            expect(leases.length).toBe(1);
          }),
        ),
      );
      const after = await readdir(join(fixture.root, ".leases"));
      expect(after).toEqual([]);
    } finally {
      await disposeTestSourceStore(fixture);
    }
  });
});
