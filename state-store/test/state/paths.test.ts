import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath } from "@lando/sdk/schema";

import { resolveStatePath } from "../../src/paths.ts";

describe("resolveStatePath", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lando-resolve-state-path-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("uses injected host roots for named state roots", async () => {
    // Given resolved runtime roots that do not come from the live environment.
    const paths = makeLandoPaths({
      userDataRoot: join(base, "host-data"),
      userConfRoot: join(base, "host-conf"),
      userCacheRoot: join(base, "host-cache"),
      sources: { user: false, env: false },
    });
    // When resolving named state buckets against that runtime's authority.
    const results = await Promise.all(
      (["userData", "userConf", "userCache"] as const).map((root) =>
        Effect.runPromise(resolveStatePath(root, "test", "proof", "open", paths.roots)),
      ),
    );
    // Then every path matches the injected roots, not ambient resolution.
    expect(results.map((result) => result.file)).toEqual([
      join(paths.roots.userDataRoot, "test", "proof"),
      join(paths.roots.userConfRoot, "test", "proof"),
      join(paths.roots.userCacheRoot, "test", "proof"),
    ]);
  });

  test("resolves a bucket under a root directory that does not exist yet", async () => {
    // Given: `root` points at a directory nobody has created yet (fresh
    // machine / first-ever bucket open), only its parent (`base`) exists.
    const rootDir = join(base, "lando");
    const root = { path: AbsolutePath.make(rootDir) };

    // When
    const resolved = await Effect.runPromise(
      resolveStatePath(root, undefined, "scratch-build-results.bin", "open"),
    );

    // Then: the file resolves inside the intended root, not rejected as an
    // escape just because the root directory hasn't been created yet.
    expect(resolved.file).toBe(join(rootDir, "scratch-build-results.bin"));
  });

  test("resolves a bucket under a root directory that already exists", async () => {
    const root = { path: AbsolutePath.make(base) };

    const resolved = await Effect.runPromise(
      resolveStatePath(root, undefined, "scratch-build-results.bin", "open"),
    );

    expect(resolved.file).toBe(join(base, "scratch-build-results.bin"));
  });

  test("resolves a bucket under a namespace when the root does not exist yet", async () => {
    const rootDir = join(base, "lando");
    const root = { path: AbsolutePath.make(rootDir) };

    const resolved = await Effect.runPromise(
      resolveStatePath(root, "build-results", "scratch-cache-write-failure.bin", "open"),
    );

    expect(resolved.file).toBe(join(rootDir, "build-results", "scratch-cache-write-failure.bin"));
  });
});
