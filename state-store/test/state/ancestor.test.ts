import { expect, test } from "bun:test";
import { dirname, join, parse, resolve } from "node:path";
import { findRealpathAncestor } from "../../src/paths.ts";

test("returns the supplied path when it resolves without climbing", async () => {
  // Given a callback resolving the target immediately
  const path = resolve("root", "target");
  const calls: string[] = [];
  // When the nearest resolvable ancestor is requested
  const result = await findRealpathAncestor(path, async (candidate) => {
    calls.push(candidate);
    return resolve("real-target");
  });
  // Then no parent is visited or suffix reconstructed
  expect(result).toEqual({ ancestor: path, realAncestor: resolve("real-target") });
  expect(calls).toEqual([path]);
});

test("returns the nearest resolved ancestor without appending missing suffixes", async () => {
  // Given two missing segments below an existing ancestor
  const ancestor = resolve("root");
  const target = join(ancestor, "missing", "file");
  const calls: string[] = [];
  // When the callback reports missing paths as null
  const result = await findRealpathAncestor(target, async (candidate) => {
    calls.push(candidate);
    return candidate === ancestor ? resolve("real-root") : null;
  });
  // Then the exact lexical and real ancestor are returned
  expect(result).toEqual({ ancestor, realAncestor: resolve("real-root") });
  expect(calls).toEqual([target, dirname(target), ancestor]);
});

test("returns null when even the filesystem root is unresolved", async () => {
  // Given a callback that cannot resolve any candidate
  const root = parse(resolve("root")).root;
  const calls: string[] = [];
  // When traversal starts at the filesystem root
  const result = await findRealpathAncestor(root, async (candidate) => {
    calls.push(candidate);
    return null;
  });
  // Then traversal terminates without a domain fallback
  expect(result).toBeNull();
  expect(calls).toEqual([root]);
});

test("propagates injected EACCES without probing a parent", async () => {
  // Given a caller that treats permission denial as an error
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const calls: string[] = [];
  const path = resolve("root", "denied");
  // When the first callback throws
  const result = findRealpathAncestor(path, async (candidate) => {
    calls.push(candidate);
    throw denied;
  });
  // Then the same error escapes and traversal stops
  expect(await result.catch((error: unknown) => error)).toBe(denied);
  expect(calls).toEqual([path]);
});
