import { describe, expect, test } from "bun:test";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { withTestSession } from "../src/testing.ts";
import {
  GC_CLOCK_NOW_MS,
  ageEntryRelativeToClock,
  disposeGcFixture,
  emptyLockKeys,
  entryDirPath,
  findEntry,
  leftoverOf,
  makeGcFixture,
  publishArchive,
  publishGit,
  runGc,
  setEntryMtimeMs,
  writeLeaseFile,
} from "./gc-support.ts";

describe("source-acquisition store.gc inventory-to-prune recheck", () => {
  test("missing lock roots survive while an include session may still publish its lockfile", async () => {
    const fixture = await makeGcFixture();
    const lockfile = join(fixture.root, "app", ".lando.lock.yml");
    try {
      const report = await Effect.runPromise(
        withTestSession(fixture.store, (session) =>
          session
            .registerRoot(lockfile)
            .pipe(
              Effect.andThen(fixture.store.gc({ prune: true, olderThanMs: 0, readLockKeys: emptyLockKeys })),
            ),
        ),
      );
      expect(leftoverOf(report, "root")[0]).toMatchObject({ eligible: false, outcome: "busy" });
      const after = await runGc(fixture.store, { prune: true, olderThanMs: 0, readLockKeys: emptyLockKeys });
      expect(leftoverOf(after, "root")[0].outcome).toBe("removed");
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("entry touched after inventory is reported busy and kept on prune recheck", async () => {
    const fixture = await makeGcFixture();
    try {
      const archive = await publishArchive(fixture, "touch-race");
      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 120_000);

      const lockfile = join(fixture.root, "app", ".lando.lock.yml");
      await mkdir(dirname(lockfile), { recursive: true });
      await writeFile(lockfile, "includes: []\n");
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(lockfile)));

      let lockReads = 0;
      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: () =>
          Effect.gen(function* () {
            lockReads += 1;
            // Second+ reachability is the prune recheck path.
            if (lockReads >= 2) {
              yield* Effect.promise(() =>
                setEntryMtimeMs(fixture.root, "archive", archive.sha256, GC_CLOCK_NOW_MS),
              );
            }
            return { status: "ok" as const, keys: [] };
          }),
      });

      expect(lockReads).toBeGreaterThanOrEqual(2);
      expect(findEntry(report, "archive", archive.sha256)).toMatchObject({
        eligible: false,
        outcome: "busy",
        reason: "touched-after-cutoff",
      });
      await access(entryDirPath(fixture.root, "archive", archive.sha256));
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("new live lease acquired between inventory and prune recheck marks entry busy", async () => {
    const fixture = await makeGcFixture();
    try {
      const archive = await publishArchive(fixture, "lease-race");
      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 120_000);

      const lockfile = join(fixture.root, "app", ".lando.lock.yml");
      await mkdir(dirname(lockfile), { recursive: true });
      await writeFile(lockfile, "includes: []\n");
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(lockfile)));

      let lockReads = 0;
      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: () =>
          Effect.gen(function* () {
            lockReads += 1;
            if (lockReads >= 2) {
              yield* Effect.promise(() =>
                writeLeaseFile(fixture.root, `race-${crypto.randomUUID()}.json`, {
                  pid: process.pid,
                  token: "race",
                  createdAt: GC_CLOCK_NOW_MS,
                  keys: [{ kind: "archive", sha256: archive.sha256 }],
                }),
              );
            }
            return { status: "ok" as const, keys: [] };
          }),
      });

      expect(lockReads).toBeGreaterThanOrEqual(2);
      expect(findEntry(report, "archive", archive.sha256)).toMatchObject({
        leased: true,
        eligible: false,
        outcome: "busy",
      });
      await access(entryDirPath(fixture.root, "archive", archive.sha256));
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("new lockfile reference between inventory and prune recheck withholds removal", async () => {
    const fixture = await makeGcFixture();
    try {
      const commit = "a".repeat(40);
      await publishGit(fixture, commit);
      await ageEntryRelativeToClock(fixture.root, "git", commit, 120_000);

      const lockfile = join(fixture.root, "app", ".lando.lock.yml");
      await mkdir(dirname(lockfile), { recursive: true });
      await writeFile(lockfile, "includes: []\n");
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(lockfile)));

      let lockReads = 0;
      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: () =>
          Effect.sync(() => {
            lockReads += 1;
            if (lockReads >= 2) {
              return {
                status: "ok" as const,
                keys: [{ kind: "git" as const, commit }],
              };
            }
            return { status: "ok" as const, keys: [] };
          }),
      });

      expect(lockReads).toBeGreaterThanOrEqual(2);
      expect(findEntry(report, "git", commit)).toMatchObject({
        protected: true,
        eligible: false,
        outcome: "kept",
        reason: "referenced",
      });
      await access(entryDirPath(fixture.root, "git", commit));
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("without a root record, eligible aged entry still prunes when nothing races", async () => {
    const fixture = await makeGcFixture();
    try {
      const archive = await publishArchive(fixture, "no-root-prune");
      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 90_000);

      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(findEntry(report, "archive", archive.sha256).outcome).toBe("removed");
      await expect(access(entryDirPath(fixture.root, "archive", archive.sha256))).rejects.toBeDefined();
    } finally {
      await disposeGcFixture(fixture);
    }
  });
});
