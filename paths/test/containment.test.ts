import { expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import { isPathWithin } from "../src/paths.ts";

for (const [suffix, contained] of [
  ["", true],
  ["child/file", true],
  ["..local/index.ts", true],
  ["../outside", false],
  ["..", false],
  ["../root-sibling/file", false],
] as const) {
  test(`classifies ${JSON.stringify(suffix)} using path segments`, () => {
    // Given a native-host root and a candidate resolved from authored segments
    const root = resolve("containment-root");
    const candidate = resolve(root, suffix);
    // When lexical containment is evaluated
    const result = isPathWithin(root, candidate);
    // Then only root equality and descendants are accepted
    expect(result).toBe(contained);
  });
}

test("rejects an absolute sibling whose name shares the root prefix", () => {
  // Given sibling paths with a shared string prefix
  const root = resolve("root");
  const candidate = join(`${root}-sibling`, "file");
  // When containment is evaluated
  const result = isPathWithin(root, candidate);
  // Then the sibling is outside
  expect(result).toBe(false);
});

test("uses native host semantics for Windows drive spellings", () => {
  // Given Windows paths, which are absolute only on a Windows host
  const root = "C:\\app";
  const candidate = "D:\\app\\file";
  // When containment is evaluated without platform injection
  const result = isPathWithin(root, candidate);
  // Then distinct drives are not descendants on either host
  expect(result).toBe(false);
});

test("handles same-drive descendants with the host separator", () => {
  // Given a native path, using a drive root on Windows
  const root = sep === "\\" ? "C:\\app" : resolve("C:\\app");
  const candidate = join(root, "..local", "file");
  // When containment is evaluated
  const result = isPathWithin(root, candidate);
  // Then a dot-prefixed segment stays inside
  expect(result).toBe(true);
});
