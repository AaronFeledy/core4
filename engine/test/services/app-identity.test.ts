import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Exit, Stream } from "effect";

import { appIdentityKey } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";

import { resolveAppIdentity } from "../../src/planner/app-identity.ts";

const processRunner = (commonDir: string | undefined): Context.Tag.Service<typeof ProcessRunner> => ({
  run: () =>
    Effect.succeed({
      exitCode: commonDir === undefined ? 128 : 0,
      stdout: commonDir === undefined ? "" : `${commonDir}\n`,
      stderr: "",
    }),
  stream: () => Stream.empty,
});

const withTempDir = async <A>(run: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-app-identity-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("rejects ownership when the app root cannot be canonicalized", async () => {
  const missingRoot = join(tmpdir(), `lando-missing-${randomUUID()}`);
  const result = await Effect.runPromiseExit(resolveAppIdentity(missingRoot));
  expect(Exit.isFailure(result)).toBe(true);
});

test("separates same-name worktrees while grouping siblings from one repository", async () => {
  await withTempDir(async (dir) => {
    // Given: two canonical app roots with the same directory name and one Git common directory.
    const left = join(dir, "left", "shared-app");
    const right = join(dir, "right", "shared-app");
    const commonDir = join(dir, "repository", ".git");
    await Promise.all([
      mkdir(left, { recursive: true }),
      mkdir(right, { recursive: true }),
      mkdir(commonDir, { recursive: true }),
    ]);

    // When: planner identity is resolved for both worktrees.
    const [leftIdentity, rightIdentity] = await Promise.all([
      Effect.runPromise(resolveAppIdentity(left, processRunner(commonDir))),
      Effect.runPromise(resolveAppIdentity(right, processRunner(commonDir))),
    ]);

    // Then: physical owners remain distinct while logical repository grouping matches.
    expect(leftIdentity.ownerKey).not.toBe(rightIdentity.ownerKey);
    expect(leftIdentity.repoGroupKey).toBe(rightIdentity.repoGroupKey);
    expect(leftIdentity.appRoot).not.toBe(rightIdentity.appRoot);
  });
});

test("keeps unrelated repositories in separate logical groups", async () => {
  await withTempDir(async (dir) => {
    // Given: same-name app roots belonging to distinct Git common directories.
    const left = join(dir, "left", "shared-app");
    const right = join(dir, "right", "shared-app");
    const leftCommonDir = join(dir, "left-repository", ".git");
    const rightCommonDir = join(dir, "right-repository", ".git");
    await Promise.all(
      [left, right, leftCommonDir, rightCommonDir].map((path) => mkdir(path, { recursive: true })),
    );

    // When: planner identity is resolved for each repository.
    const [leftIdentity, rightIdentity] = await Promise.all([
      Effect.runPromise(resolveAppIdentity(left, processRunner(leftCommonDir))),
      Effect.runPromise(resolveAppIdentity(right, processRunner(rightCommonDir))),
    ]);

    // Then: neither physical nor repository identity collides.
    expect(leftIdentity.ownerKey).not.toBe(rightIdentity.ownerKey);
    expect(leftIdentity.repoGroupKey).not.toBe(rightIdentity.repoGroupKey);
  });
});

test("retains canonical ownership when Git grouping is unavailable", async () => {
  await withTempDir(async (dir) => {
    // Given: an existing app root outside a Git repository.
    const root = join(dir, "standalone-app");
    await mkdir(root);

    // When: Git common-directory discovery reports no repository.
    const identity = await Effect.runPromise(resolveAppIdentity(root, processRunner(undefined)));

    // Then: canonical ownership remains available without an unsafe group fallback.
    expect(String(identity.appRoot)).toBe(root);
    expect(identity.ownerKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(identity.ownerKey).toBe(appIdentityKey("owner", await realpath(root)));
    expect(identity.repoGroupKey).toBeUndefined();
  });
});
