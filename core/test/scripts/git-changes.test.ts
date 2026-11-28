import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  GitChangeError,
  discoverChanges,
  listGitVisibleFiles,
  readFileAtCommit,
} from "../../../scripts/git-changes.ts";

const roots: string[] = [];

const put = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
};

const git = async (root: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${error}`);
  return out.trim();
};

const commit = (root: string, message: string): Promise<string> =>
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    message,
  ).then(() => git(root, "rev-parse", "HEAD"));

const repository = async (files: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-git-changes-"));
  roots.push(root);
  await put(root, ".gitignore", "ignored.txt\n");
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await git(root, "init", "-q");
  await git(root, "add", ".");
  await commit(root, "base");
  return root;
};

const rejection = async (promise: Promise<unknown>): Promise<GitChangeError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitChangeError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with a GitChangeError");
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reports a staged edit and an unstaged edit against the base ref", async () => {
  const root = await repository({ "src/covered.ts": "export const a = 1;\n" });

  await put(root, "src/covered.ts", "export const a = 2;\n");
  await git(root, "add", "src/covered.ts");
  expect((await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths).toEqual([
    "src/covered.ts",
  ]);

  await put(root, "src/covered.ts", "export const a = 3;\n");
  expect((await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths).toEqual([
    "src/covered.ts",
  ]);
});

test("reports the net difference: an edit staged and restored on disk is not a change", async () => {
  const root = await repository({ "src/covered.ts": "export const a = 1;\n" });

  await put(root, "src/covered.ts", "export const a = 2;\n");
  await git(root, "add", "src/covered.ts");
  await put(root, "src/covered.ts", "export const a = 1;\n");

  expect((await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths).toEqual([]);
});

test("reports an untracked file but not a gitignored one", async () => {
  const root = await repository({ "src/covered.ts": "export const a = 1;\n" });

  await put(root, "src/new.ts", "export {};\n");
  await put(root, "ignored.txt", "not tracked\n");

  expect((await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths).toEqual([
    "src/new.ts",
  ]);
});

test("reports both paths of a rename under the base ref", async () => {
  const root = await repository({ "src/old-name.ts": "export {};\n" });

  await rename(join(root, "src/old-name.ts"), join(root, "src/new-name.ts"));
  await git(root, "add", "-A");

  expect((await discoverChanges(root, { kind: "working-tree", baseRef: "HEAD" })).paths).toEqual([
    "src/new-name.ts",
    "src/old-name.ts",
  ]);
});

test("reports a commit after the base and a deletion between two commits", async () => {
  const root = await repository({ "src/kept.ts": "export {};\n", "src/removed.ts": "export {};\n" });
  const base = await git(root, "rev-parse", "HEAD");

  await put(root, "src/kept.ts", "export const kept = 1;\n");
  await put(root, "src/added.ts", "export {};\n");
  await rm(join(root, "src/removed.ts"));
  await git(root, "add", "-A");
  const head = await commit(root, "second");

  const changes = await discoverChanges(root, { kind: "commits", base, head });
  expect(changes.paths).toEqual(["src/added.ts", "src/kept.ts", "src/removed.ts"]);
  expect(changes.base).toBe(base);
  expect(changes.head).toBe(head);
});

test("commits mode ignores working-tree edits", async () => {
  const root = await repository({ "src/covered.ts": "export const a = 1;\n" });
  const base = await git(root, "rev-parse", "HEAD");
  await put(root, "src/covered.ts", "export const a = 2;\n");
  await git(root, "add", "-A");
  const head = await commit(root, "second");

  await put(root, "src/covered.ts", "export const a = 3;\n");

  expect((await discoverChanges(root, { kind: "commits", base, head })).paths).toEqual(["src/covered.ts"]);
});

test("compares from the merge base and still reports the base commit when the base is ahead", async () => {
  const root = await repository({ "src/shared.ts": "export const shared = 1;\n" });
  const branchPoint = await git(root, "rev-parse", "HEAD");

  await git(root, "checkout", "-q", "-b", "side");
  await put(root, "src/side-only.ts", "export {};\n");
  await git(root, "add", "-A");
  const base = await commit(root, "side");
  expect(branchPoint).not.toBe(base);

  await git(root, "checkout", "-q", "-");
  await put(root, "src/feature.ts", "export {};\n");
  await git(root, "add", "-A");
  const head = await commit(root, "feature");

  const changes = await discoverChanges(root, { kind: "commits", base, head });
  expect(changes.base).toBe(base);
  expect(changes.mergeBase).toBe(branchPoint);
  expect(changes.paths).toEqual(["src/feature.ts"]);
});

test("rejects a head that is not a commit with a labelled error and a remediation", async () => {
  const root = await repository({ "src/covered.ts": "export {};\n" });
  const base = await git(root, "rev-parse", "HEAD");

  const error = await rejection(discoverChanges(root, { kind: "commits", base, head: "not-an-object" }));
  expect(error._tag).toBe("GitChangeError");
  expect(error.remediation.length).toBeGreaterThan(0);
});

test("rejects an unknown base ref and a directory that is not a repository", async () => {
  const root = await repository({ "src/covered.ts": "export {};\n" });
  const unknownRef = await rejection(
    discoverChanges(root, { kind: "working-tree", baseRef: "origin/does-not-exist" }),
  );
  expect(unknownRef._tag).toBe("GitChangeError");
  expect(unknownRef.remediation).toContain("GUIDE_DRIFT_BASE_REF");

  const plain = await mkdtemp(join(tmpdir(), "lando-git-changes-plain-"));
  roots.push(plain);
  await put(plain, "src/covered.ts", "export {};\n");
  const notRepository = await rejection(discoverChanges(plain, { kind: "working-tree", baseRef: "HEAD" }));
  expect(notRepository._tag).toBe("GitChangeError");
  expect(notRepository.remediation).toContain("git");
});

test("lists git-visible files", async () => {
  const root = await repository({ "src/covered.ts": "export {};\n" });
  await put(root, "src/untracked.ts", "export {};\n");
  await put(root, "ignored.txt", "not tracked\n");

  expect(await listGitVisibleFiles(root)).toEqual([".gitignore", "src/covered.ts", "src/untracked.ts"]);
});

test("reads a file at a commit and reports a path absent there as undefined", async () => {
  const root = await repository({ "src/covered.ts": "export const a = 1;\n" });
  const base = await git(root, "rev-parse", "HEAD");

  expect(await readFileAtCommit(root, base, "src/covered.ts")).toBe("export const a = 1;\n");
  expect(await readFileAtCommit(root, base, "src/added-later.ts")).toBeUndefined();
  expect((await rejection(readFileAtCommit(root, "not-a-commit", "src/covered.ts")))._tag).toBe(
    "GitChangeError",
  );
});
