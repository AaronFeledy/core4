import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { SourceAcquisitionError } from "../src/errors.ts";
import { sourceRecords } from "../src/records.ts";
import { withTestSources } from "../src/testing.ts";
import type { GitTransport } from "../src/types.ts";

const FULL_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

type ResolveInput = {
  readonly url: string;
  readonly ref?: string;
  readonly signal?: AbortSignal;
};

interface ResolvingFakeGit {
  readonly transport: GitTransport & {
    readonly resolve: (input: ResolveInput) => Promise<string | undefined>;
  };
  readonly fetchCalls: Array<{ url: string; ref?: string }>;
  readonly resolveCalls: Array<{ url: string; ref?: string }>;
  setRef: (ref: string, commit: string, files: Readonly<Record<string, string>>) => void;
  setResolve: (ref: string, commit: string | undefined) => void;
  nextResolveError?: unknown;
  nextFetchError?: unknown;
}

const makeResolvingFakeGit = (): ResolvingFakeGit => {
  const refs = new Map<string, { commit: string; files: Readonly<Record<string, string>> }>();
  const resolveMap = new Map<string, string | undefined>();
  const fetchCalls: Array<{ url: string; ref?: string }> = [];
  const resolveCalls: Array<{ url: string; ref?: string }> = [];
  const fake: ResolvingFakeGit = {
    fetchCalls,
    resolveCalls,
    setRef: (ref, commit, files) => void refs.set(ref, { commit, files }),
    setResolve: (ref, commit) => void resolveMap.set(ref, commit),
    transport: {
      resolve: async ({ url, ref }) => {
        resolveCalls.push({ url, ...(ref === undefined ? {} : { ref }) });
        if (fake.nextResolveError !== undefined) {
          const err = fake.nextResolveError;
          fake.nextResolveError = undefined;
          throw err;
        }
        const key = ref ?? "HEAD";
        if (!resolveMap.has(key)) throw new Error(`no resolve fixture for ${key}`);
        return resolveMap.get(key);
      },
      fetch: async ({ url, ref, dest }) => {
        fetchCalls.push({ url, ...(ref === undefined ? {} : { ref }) });
        if (fake.nextFetchError !== undefined) {
          const error = fake.nextFetchError;
          fake.nextFetchError = undefined;
          throw error;
        }
        const key = ref ?? "HEAD";
        const hit = refs.get(key);
        if (hit === undefined) throw new Error(`no git fixture for ref ${key}`);
        for (const [rel, content] of Object.entries(hit.files)) {
          const target = join(dest, rel);
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, content);
        }
        await mkdir(join(dest, ".git"), { recursive: true });
        await writeFile(join(dest, ".git", "HEAD"), "ref: refs/heads/main\n");
        return { commit: hit.commit };
      },
    },
  };
  return fake;
};

describe("acquireGit resolve cache fast path", () => {
  test("cached resolve skips fetch and writes a usable ref record", async () => {
    const git = makeResolvingFakeGit();
    git.setRef(FULL_SHA, FULL_SHA, { version: "first" });
    git.setResolve("main", FULL_SHA);

    await withTestSources({ git: git.transport }, ({ session, stateStore }) =>
      Effect.gen(function* () {
        const first = yield* session.acquireGit({ url: "https://example.test/seed.git", ref: FULL_SHA });
        expect(first.pin.commit).toBe(FULL_SHA);
        expect(git.fetchCalls).toHaveLength(1);
        expect(git.resolveCalls).toHaveLength(0);

        const again = yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        expect(again.root).toBe(first.root);
        expect(again.pin.commit).toBe(FULL_SHA);
        expect(git.fetchCalls).toHaveLength(1);
        expect(git.resolveCalls).toHaveLength(1);

        const record = yield* sourceRecords(stateStore)
          .ref("https://example.test/r.git", "main")
          .pipe(Effect.flatMap((bucket) => bucket.get));
        expect(record).toEqual({ commit: FULL_SHA });
      }),
    );
  });

  test("uncached resolve falls through to fetch with the ref name", async () => {
    const git = makeResolvingFakeGit();
    git.setRef("main", OTHER_SHA, { version: "fresh" });
    git.setResolve("main", OTHER_SHA);

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        expect(snap.pin.commit).toBe(OTHER_SHA);
        expect(git.resolveCalls).toEqual([{ url: "https://example.test/r.git", ref: "main" }]);
        expect(git.fetchCalls).toEqual([{ url: "https://example.test/r.git", ref: "main" }]);
      }),
    );
  });

  test("resolve fetch-failed falls through to fetch so stale fallback still owns the path", async () => {
    const git = makeResolvingFakeGit();
    git.setRef("main", FULL_SHA, { version: "warm" });
    git.setResolve("main", FULL_SHA);

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.acquireGit({ url: "https://example.test/stale.git", ref: "main" });
        expect(git.fetchCalls).toHaveLength(1);

        git.nextResolveError = new SourceAcquisitionError({
          message: "ls-remote failed",
          source: "https://example.test/stale.git",
          kind: "fetch-failed",
          remediation: "Retry when the remote is reachable.",
        });
        git.nextFetchError = new SourceAcquisitionError({
          message: "network down",
          source: "https://example.test/stale.git",
          kind: "fetch-failed",
          remediation: "Retry when the remote is reachable.",
        });
        const stale: string[] = [];
        const snap = yield* session.acquireGit(
          { url: "https://example.test/stale.git", ref: "main" },
          { onStaleFallback: (commit) => void stale.push(commit) },
        );
        expect(snap.pin.commit).toBe(FULL_SHA);
        expect(stale).toEqual([FULL_SHA]);
        expect(git.resolveCalls).toHaveLength(2);
        expect(git.fetchCalls).toHaveLength(2);
      }),
    );
  });

  test("resolve failure still allows a successful fetch", async () => {
    const git = makeResolvingFakeGit();
    git.setRef("main", FULL_SHA, { version: "fresh" });
    git.nextResolveError = new SourceAcquisitionError({
      message: "ls-remote unavailable",
      source: "https://example.test/r.git",
      kind: "fetch-failed",
      remediation: "Retry the fetch.",
    });
    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snapshot = yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        expect(snapshot.pin.commit).toBe(FULL_SHA);
        expect(git.fetchCalls).toEqual([{ url: "https://example.test/r.git", ref: "main" }]);
      }),
    );
  });

  test("resolve auth error is rethrown without fetch", async () => {
    const git = makeResolvingFakeGit();
    git.setResolve("main", FULL_SHA);
    git.nextResolveError = new SourceAcquisitionError({
      message: "Authentication failed: publickey",
      source: "https://example.test/private.git",
      kind: "auth",
      remediation: "Provide credentials and retry.",
    });

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          session.acquireGit({ url: "https://example.test/private.git", ref: "main" }),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "auth" } });
        expect(git.fetchCalls).toHaveLength(0);
        expect(git.resolveCalls).toHaveLength(1);
      }),
    );
  });

  test("repair reuses an intact cached commit and refetches only a tampered tree", async () => {
    const git = makeResolvingFakeGit();
    git.setRef("main", FULL_SHA, { version: "v1" });
    git.setResolve("main", FULL_SHA);

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        const first = yield* session.acquireGit({ url: "https://example.test/r.git", ref: "main" });
        expect(git.fetchCalls).toHaveLength(1);
        const intact = yield* session.acquireGit(
          { url: "https://example.test/r.git", ref: "main" },
          { repair: true },
        );
        expect(intact.pin.commit).toBe(FULL_SHA);
        expect(git.fetchCalls).toHaveLength(1);
        expect(git.resolveCalls).toHaveLength(2);

        yield* Effect.promise(() => writeFile(join(first.root, "version"), "tampered"));
        const repaired = yield* session.acquireGit(
          { url: "https://example.test/r.git", ref: "main" },
          { repair: true },
        );
        expect(git.fetchCalls).toHaveLength(2);
        expect(yield* Effect.promise(() => Bun.file(join(repaired.root, "version")).text())).toBe("v1");
      }),
    );
  });

  test("pinned full SHA bypasses resolve when the entry is warm", async () => {
    const git = makeResolvingFakeGit();
    git.setRef(FULL_SHA, FULL_SHA, { version: "pinned" });
    git.setResolve(FULL_SHA, FULL_SHA);

    await withTestSources({ git: git.transport }, ({ session }) =>
      Effect.gen(function* () {
        yield* session.acquireGit({ url: "https://example.test/r.git", ref: FULL_SHA });
        expect(git.fetchCalls).toHaveLength(1);
        const again = yield* session.acquireGit({ url: "https://example.test/r.git", ref: FULL_SHA });
        expect(again.pin.commit).toBe(FULL_SHA);
        expect(git.fetchCalls).toHaveLength(1);
        expect(git.resolveCalls).toHaveLength(0);
      }),
    );
  });
});
