import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { withTestSources } from "../src/testing.ts";
import { makeFakeArchiveTransport, makeTarGz, sha256Of } from "./support.ts";

describe("entry validation and repair", () => {
  test.each([
    { label: "invalid JSON", record: "{" },
    { label: "wrong version", record: JSON.stringify({ version: 2 }) },
    {
      label: "mismatched id",
      record: JSON.stringify({
        version: 1,
        format: 1,
        kind: "archive",
        id: "0".repeat(64),
        treeDigest: "a".repeat(64),
        provenance: { source: "fixture" },
      }),
    },
    {
      label: "mismatched kind",
      record: JSON.stringify({
        version: 1,
        format: 1,
        kind: "git",
        id: "0".repeat(64),
        treeDigest: "a".repeat(64),
        provenance: { source: "fixture" },
      }),
    },
  ])("replaces an entry with $label before returning its tree", async ({ record }) => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("authoritative") }]);
    const url = "https://example.test/source.tgz";
    const sha256 = sha256Of(bytes);
    archive.set(url, bytes);
    await withTestSources({ archive: archive.transport }, ({ session, root }) =>
      Effect.gen(function* () {
        const original = yield* session.acquireArchive({ url, sha256 });
        yield* Effect.promise(() => writeFile(join(root, "archive", sha256, "entry.json"), record));
        expect(yield* session.openArchive(sha256)).toBeUndefined();
        const repaired = yield* session.acquireArchive({ url, sha256 });
        expect(repaired.root).toBe(original.root);
        expect(yield* Effect.promise(() => readFile(join(repaired.root, "file"), "utf8"))).toBe(
          "authoritative",
        );
        expect(archive.calls).toHaveLength(2);
      }),
    );
  });

  test("normal opens preserve a poisoned tree until explicit repair", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("authoritative") }]);
    const url = "https://example.test/source.tgz";
    const sha256 = sha256Of(bytes);
    archive.set(url, bytes);
    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const original = yield* session.acquireArchive({ url, sha256 });
        yield* Effect.promise(() => writeFile(join(original.root, "file"), "poison"));
        const warm = yield* session.acquireArchive({ url, sha256 });
        expect(yield* Effect.promise(() => readFile(join(warm.root, "file"), "utf8"))).toBe("poison");
        const repaired = yield* session.acquireArchive({ url, sha256 }, { repair: true });
        expect(yield* Effect.promise(() => readFile(join(repaired.root, "file"), "utf8"))).toBe(
          "authoritative",
        );
      }),
    );
  });

  test("repair keeps an intact entry without refetching", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "file", bytes: new TextEncoder().encode("same") }]);
    const url = "https://example.test/same.tgz";
    const sha256 = sha256Of(bytes);
    archive.set(url, bytes);
    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const original = yield* session.acquireArchive({ url, sha256 });
        const before = yield* Effect.promise(() => stat(join(original.root, "file")));
        const repaired = yield* session.acquireArchive({ url, sha256 }, { repair: true });
        const after = yield* Effect.promise(() => stat(join(repaired.root, "file")));
        expect(after.ino).toBe(before.ino);
        expect(archive.calls).toHaveLength(1);
      }),
    );
  });
});
