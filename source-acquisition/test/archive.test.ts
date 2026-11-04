import { describe, expect, test } from "bun:test";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { withTestSources } from "../src/testing.ts";
import { makeFakeArchiveTransport, makeTar, makeTarGz, sha256Of } from "./support.ts";

describe("source-acquisition archive", () => {
  test("checksum hit skips download on second acquire", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "hello.txt", bytes: new TextEncoder().encode("hello\n") }]);
    const sha256 = sha256Of(bytes);
    const url = "https://example.test/hello.tgz";
    archive.set(url, bytes);

    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const first = yield* session.acquireArchive({ url, sha256 });
        expect(first.key).toEqual({ kind: "archive", sha256 });
        expect(archive.calls).toEqual([url]);
        expect(yield* Effect.promise(() => readFile(join(first.root, "hello.txt"), "utf8"))).toBe("hello\n");

        const second = yield* session.materializeArchive({ kind: "archive", url, sha256 });
        expect(second.root).toBe(first.root);
        expect(archive.calls).toEqual([url]);
      }),
    );
  });

  test("checksum mismatch fails before extraction", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "a.txt", bytes: new TextEncoder().encode("a") }]);
    const url = "https://example.test/a.tgz";
    archive.set(url, bytes);
    const wrong = "0".repeat(64);

    await withTestSources({ archive: archive.transport }, ({ session, root }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(session.acquireArchive({ url, sha256: wrong }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.kind).toBe("checksum-mismatch");
        }
        const entries = yield* Effect.promise(() => readdir(root));
        expect(entries.includes("archive")).toBe(false);
      }),
    );
  });

  test("onUnverified receives computed sha256 when locator has no checksum", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "u.txt", bytes: new TextEncoder().encode("u") }]);
    const url = "https://example.test/u.tgz";
    archive.set(url, bytes);
    const expected = sha256Of(bytes);
    const seen: string[] = [];

    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const snap = yield* session.acquireArchive({ url }, { onUnverified: (sha) => void seen.push(sha) });
        expect(snap.pin.sha256).toBe(expected);
        expect(seen).toEqual([expected]);
      }),
    );
  });

  test("openArchive returns published entry and registers lease", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "l.txt", bytes: new TextEncoder().encode("lease") }]);
    const sha256 = sha256Of(bytes);
    const url = "https://example.test/l.tgz";
    archive.set(url, bytes);

    await withTestSources({ archive: archive.transport }, ({ session, root }) =>
      Effect.gen(function* () {
        yield* session.acquireArchive({ url, sha256 });
        const hit = yield* session.openArchive(sha256);
        expect(hit?.key).toEqual({ kind: "archive", sha256 });
        const leases = yield* Effect.promise(() => readdir(join(root, ".leases")));
        expect(leases.length).toBe(1);
        const [leaseFile] = leases;
        if (leaseFile === undefined || hit === undefined) throw new Error("Expected a leased snapshot");
        const lease: unknown = JSON.parse(
          yield* Effect.promise(() => readFile(join(root, ".leases", leaseFile), "utf8")),
        );
        expect(lease).toMatchObject({ pid: process.pid, keys: [{ kind: "archive", sha256 }] });
        yield* Effect.promise(() => access(join(hit.root, "l.txt")));
      }),
    );
  });

  test("traversal entries fail extract-failed", async () => {
    const archive = makeFakeArchiveTransport();
    const evil = makeTar([{ name: "../escape.txt", bytes: new TextEncoder().encode("nope") }]);
    const url = "https://example.test/evil.tar";
    archive.set(url, evil);

    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(session.acquireArchive({ url }));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.kind).toBe("extract-failed");
      }),
    );
  });

  test("repair re-fetches archive bytes only when the cached tree changed", async () => {
    const archive = makeFakeArchiveTransport();
    const bytes = makeTarGz([{ name: "r.txt", bytes: new TextEncoder().encode("r1") }]);
    const sha256 = sha256Of(bytes);
    const url = "https://example.test/r.tgz";
    archive.set(url, bytes);

    await withTestSources({ archive: archive.transport }, ({ session }) =>
      Effect.gen(function* () {
        const first = yield* session.acquireArchive({ url, sha256 });
        expect(archive.calls).toHaveLength(1);
        yield* session.acquireArchive({ url, sha256 }, { repair: true });
        expect(archive.calls).toHaveLength(1);
        yield* Effect.promise(() => writeFile(join(first.root, "r.txt"), "tampered"));
        const repaired = yield* session.acquireArchive({ url, sha256 }, { repair: true });
        expect(archive.calls).toHaveLength(2);
        expect(yield* Effect.promise(() => readFile(join(repaired.root, "r.txt"), "utf8"))).toBe("r1");
      }),
    );
  });
});
