import { describe, expect, test } from "bun:test";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { SourceGcReportSchema } from "@lando/source-acquisition/gc";
import { Effect, Schema } from "effect";
import { sourceRecords } from "../src/records.ts";
import { withTestSession } from "../src/testing.ts";
import {
  GC_CLOCK_NOW_MS,
  ageEntryRelativeToClock,
  disposeGcFixture,
  emptyLockKeys,
  entryDirPath,
  findEntry,
  fingerprintStore,
  fingerprintsEqual,
  leftoverOf,
  makeGcFixture,
  okLockKeys,
  publishArchive,
  publishGit,
  publishNpm,
  runGc,
  setEntryMtimeMs,
  writeInvalidEntry,
  writeLeftoverDir,
} from "./gc-support.ts";

describe("source-acquisition store.gc core inventory and prune", () => {
  test("report-only does not mutate the filesystem (entries, leftovers, state records, mtimes)", async () => {
    const fixture = await makeGcFixture();
    try {
      const archive = await publishArchive(fixture, "report-raw");
      const gitCommit = "a".repeat(40);
      await publishGit(fixture, gitCommit);
      const npm = await publishNpm(fixture, "gc-pkg", "1.0.0", "report");
      await Effect.runPromise(
        withTestSession(fixture.store, (session) =>
          session.registerRoot(join(fixture.root, "apps", "demo", ".lando.lock.yml")),
        ),
      );
      await writeLeftoverDir(fixture.root, `.staging-${process.pid}-${crypto.randomUUID()}`, "stage");
      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 60_000);
      await ageEntryRelativeToClock(fixture.root, "git", gitCommit, 60_000);
      await ageEntryRelativeToClock(fixture.root, "archive", npm.sha256, 60_000);

      const before = await fingerprintStore(fixture.root);
      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      const after = await fingerprintStore(fixture.root);

      expect(fingerprintsEqual(before, after)).toBe(true);
      expect(report.prune).toBe(false);
      expect(report.entries.every((e) => e.outcome !== "removed")).toBe(true);
      expect(report.entries.some((e) => e.eligible)).toBe(true);
      Schema.decodeUnknownSync(SourceGcReportSchema)(report);
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("age gates valid entries while invalid records stay eligible regardless of mtime", async () => {
    const fixture = await makeGcFixture();
    try {
      const oldHit = await publishArchive(fixture, "old-valid");
      const youngHit = await publishArchive(fixture, "young-valid");
      const invalidId = "b".repeat(64);
      await writeInvalidEntry(fixture.root, "archive", invalidId);

      await ageEntryRelativeToClock(fixture.root, "archive", oldHit.sha256, 120_000);
      await ageEntryRelativeToClock(fixture.root, "archive", youngHit.sha256, 30_000);
      await setEntryMtimeMs(fixture.root, "archive", invalidId, GC_CLOCK_NOW_MS - 1_000);

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 60_000,
        readLockKeys: emptyLockKeys,
      });

      expect(findEntry(report, "archive", oldHit.sha256)).toMatchObject({
        valid: true,
        eligible: true,
        outcome: "kept",
        reason: "eligible",
      });
      expect(findEntry(report, "archive", youngHit.sha256)).toMatchObject({
        valid: true,
        eligible: false,
        outcome: "kept",
      });
      expect(findEntry(report, "archive", invalidId)).toMatchObject({
        valid: false,
        eligible: true,
        outcome: "kept",
      });
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("missing lockfile root records are removed on prune", async () => {
    const fixture = await makeGcFixture();
    try {
      const missingLock = join(fixture.root, "gone", ".lando.lock.yml");
      await mkdir(dirname(missingLock), { recursive: true });
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(missingLock)));
      const rootKey = `root-${sha256Hex(missingLock)}`;
      await access(join(fixture.root, rootKey));

      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: () => Effect.succeed({ status: "missing" }),
      });

      expect(report.reachability).toBe("complete");
      expect(report.roots).toEqual([{ lockfile: missingLock, status: "missing" }]);
      await expect(access(join(fixture.root, rootKey))).rejects.toBeDefined();
      expect(leftoverOf(report, "root", rootKey)[0]).toMatchObject({
        outcome: "removed",
        eligible: true,
        reason: "missing-lockfile",
      });
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("report-only leftover reasons describe records whose lockfile or entry still exists", async () => {
    const fixture = await makeGcFixture();
    try {
      const lockfile = join(fixture.root, "app", ".lando.lock.yml");
      await mkdir(dirname(lockfile), { recursive: true });
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(lockfile)));
      const git = await publishGit(fixture, "2".repeat(40));
      const npm = await publishNpm(fixture, "present-pkg", "1.0.0", "present");

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: okLockKeys([{ kind: "git", commit: git.commit }]),
      });

      const rootRow = leftoverOf(report, "root", `root-${sha256Hex(lockfile)}`)[0];
      expect(rootRow).toMatchObject({ eligible: false, outcome: "kept", reason: "lockfile-present" });
      const refRows = report.leftovers.filter((row) => row.kind === "ref");
      expect(refRows.length).toBeGreaterThan(0);
      for (const row of refRows)
        expect(row).toMatchObject({ eligible: false, outcome: "kept", reason: "entry-present" });
      const indexRows = report.leftovers.filter((row) => row.kind === "npm-index");
      expect(indexRows).toHaveLength(1);
      expect(indexRows[0]).toMatchObject({ eligible: false, outcome: "kept", reason: "entry-present" });
      expect(findEntry(report, "archive", npm.sha256)?.outcome).toBe("kept");
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("prune removes eligible physical entries; dangling npm-index and ref leftovers clean up", async () => {
    const fixture = await makeGcFixture();
    try {
      const keep = await publishArchive(fixture, "keep-young");
      const drop = await publishArchive(fixture, "drop-old");
      const gitDrop = "1".repeat(40);
      await publishGit(fixture, gitDrop);
      const npm = await publishNpm(fixture, "idx-pkg", "9.9.9", "idx");

      await Effect.runPromise(
        Effect.gen(function* () {
          const bucket = yield* sourceRecords(fixture.stateStore).npm(
            "https://registry.npmjs.org/",
            "dangling-pkg",
            "0.0.1",
          );
          yield* bucket.set({
            name: "dangling-pkg",
            version: "0.0.1",
            registry: "https://registry.npmjs.org/",
            sha256: "2".repeat(64),
          });
          const ref = yield* sourceRecords(fixture.stateStore).ref(
            "https://example.test/missing.git",
            "main",
          );
          yield* ref.set({ commit: "3".repeat(40) });
        }),
      );

      await ageEntryRelativeToClock(fixture.root, "archive", drop.sha256, 90_000);
      await ageEntryRelativeToClock(fixture.root, "git", gitDrop, 90_000);
      await ageEntryRelativeToClock(fixture.root, "archive", npm.sha256, 90_000);
      await ageEntryRelativeToClock(fixture.root, "archive", keep.sha256, 1_000);

      // Independent inventory of what must leave before prune mutates.
      const preview = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 30_000,
        readLockKeys: emptyLockKeys,
      });
      const mustDrop = [drop.sha256, gitDrop, npm.sha256] as const;
      const previewDropBytes = mustDrop.map((id) => {
        const kind = id.length === 40 ? ("git" as const) : ("archive" as const);
        const row = findEntry(preview, kind, id);
        expect(row.eligible).toBe(true);
        return row.bytes;
      });
      const expectedRemovedBytes = previewDropBytes.reduce((sum, n) => sum + n, 0);
      expect(findEntry(preview, "archive", keep.sha256).eligible).toBe(false);

      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 30_000,
        readLockKeys: emptyLockKeys,
      });

      expect(findEntry(report, "archive", drop.sha256).outcome).toBe("removed");
      expect(findEntry(report, "git", gitDrop).outcome).toBe("removed");
      expect(findEntry(report, "archive", npm.sha256).outcome).toBe("removed");
      expect(findEntry(report, "archive", keep.sha256)).toMatchObject({
        eligible: false,
        outcome: "kept",
      });

      await expect(access(entryDirPath(fixture.root, "archive", drop.sha256))).rejects.toBeDefined();
      await access(entryDirPath(fixture.root, "archive", keep.sha256));

      expect(leftoverOf(report, "npm-index").map((row) => row.outcome)).toEqual(["removed", "removed"]);
      expect(leftoverOf(report, "ref").map((row) => row.outcome)).toEqual(["removed", "removed"]);

      // Totals are physical-entry-only; leftover removals must not inflate removed count.
      const removedIds = report.entries
        .filter((e) => e.outcome === "removed")
        .map((e) => e.id)
        .sort();
      expect(removedIds).toEqual([...mustDrop].sort());
      expect(report.totals.removed).toBe(mustDrop.length);
      expect(report.totals.removedBytes).toBe(expectedRemovedBytes);
      expect(report.totals.eligible).toBe(mustDrop.length);
      expect(report.totals.withheld).toBe(0);
      expect(report.totals.busy).toBe(0);
    } finally {
      await disposeGcFixture(fixture);
    }
  });
});
