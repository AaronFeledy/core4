import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveStatePath } from "../../src/paths.ts";

let base: string;
beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lando-state-containment-")));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

for (const key of ["..local", "."]) {
  test(`allows contained state key ${key}`, async () => {
    // Given a root and a single contained segment or root equality
    const root = { path: AbsolutePath.make(base) };
    // When state path resolution runs
    const result = await Effect.runPromise(resolveStatePath(root, undefined, key, "open"));
    // Then the state consumer preserves equality and segment-aware containment
    expect(result.file).toBe(join(base, key));
  });
}

test("rejects a true parent segment", async () => {
  // Given a key that names the root's parent
  const root = { path: AbsolutePath.make(base) };
  // When state path resolution runs
  const result = await Effect.runPromise(Effect.result(resolveStatePath(root, undefined, "..", "open")));
  // Then the state domain error is preserved
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.reason).toBe("path");
});

test("reconstructs missing root and target suffixes beneath a symlinked ancestor", async () => {
  // Given a root below a symlink and several missing path segments
  const actual = join(base, "actual");
  await fs.mkdir(actual);
  await fs.symlink(actual, join(base, "alias"), "junction");
  const root = { path: AbsolutePath.make(join(base, "alias", "missing", "root")) };
  // When state path resolution runs
  const result = await Effect.runPromise(resolveStatePath(root, "namespace", "key", "open"));
  // Then both suffixes are retained beneath the resolved ancestor
  expect(result).toEqual({
    rootReal: join(actual, "missing", "root"),
    file: join(actual, "missing", "root", "namespace", "key"),
  });
});

test("rejects a missing target below an escaping symlink", async () => {
  // Given a symlinked namespace pointing above the root
  await fs.symlink(join(base, ".."), join(base, "linked"), "junction");
  // When resolving an absent file beneath that namespace
  const result = await Effect.runPromise(
    Effect.result(resolveStatePath({ path: AbsolutePath.make(base) }, "linked", "missing", "open")),
  );
  // Then ancestor reconstruction exposes the escape
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.reason).toBe("path");
});

test("climbs on injected EACCES and reconstructs the missing target", async () => {
  // Given a successful root lookup followed by a denied target lookup
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockResolvedValueOnce(base).mockRejectedValueOnce(denied);
  try {
    // When state path resolution encounters the denial
    const result = await Effect.runPromise(
      resolveStatePath({ path: AbsolutePath.make(base) }, undefined, "key", "open"),
    );
    // Then this caller's catch-all climbing policy retains the target suffix
    expect(result.file).toBe(join(base, "key"));
    expect(lookup.mock.calls.map(([path]) => path)).toEqual([base, join(base, "key"), base]);
  } finally {
    lookup.mockRestore();
  }
});

test("retains the original root when no ancestor can resolve", async () => {
  // Given a caller whose every filesystem lookup fails
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const lookup = spyOn(fs, "realpath").mockRejectedValue(denied);
  try {
    // When root and target traversal exhaust all ancestors
    const result = await Effect.runPromise(
      resolveStatePath({ path: AbsolutePath.make(base) }, undefined, "key", "open"),
    );
    // Then state-store keeps its original-path fallback
    expect(result).toEqual({ rootReal: base, file: join(base, "key") });
  } finally {
    lookup.mockRestore();
  }
});
