import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";

import { resolveStatePath } from "../../src/state/paths.ts";

describe("resolveStatePath", () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "lando-resolve-state-path-"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
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
