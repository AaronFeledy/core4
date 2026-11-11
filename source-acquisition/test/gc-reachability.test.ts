import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { withTestSession } from "../src/testing.ts";
import {
  ageEntryRelativeToClock,
  disposeGcFixture,
  findEntry,
  makeGcFixture,
  okLockKeys,
  publishArchive,
  publishGit,
  publishNpm,
  runGc,
} from "./gc-support.ts";
import { npmVersion, packageTarball, sriSha512 } from "./support.ts";

describe("source-acquisition store.gc lockfile reachability", () => {
  test("ok lockfiles protect git commits and every registry archive for locked npm name@version", async () => {
    const fixture = await makeGcFixture();
    try {
      const protectedCommit = "c".repeat(40);
      const freeCommit = "d".repeat(40);
      await publishGit(fixture, protectedCommit, { "a.txt": "p" });
      await publishGit(fixture, freeCommit, { "b.txt": "f" });

      const npmA = await publishNpm(fixture, "locked-pkg", "2.0.0", "a");
      const otherBytes = packageTarball({
        "package.json": '{"n":"locked-pkg","v":"2.0.0","other":true}',
      });
      const otherTarball = "https://example.test/locked-pkg-other.tgz";
      fixture.npm.setRegistry("https://other.registry.test/");
      fixture.npm.setPackument(
        "locked-pkg",
        npmVersion({
          name: "locked-pkg",
          version: "2.0.0",
          dist: { tarball: otherTarball, integrity: sriSha512(otherBytes) },
        }),
      );
      fixture.npm.setTarball(otherTarball, otherBytes);
      const otherSnap = await Effect.runPromise(
        withTestSession(fixture.store, (session) =>
          session.acquireNpm({ name: "locked-pkg", selector: "2.0.0" }),
        ),
      );
      if (otherSnap.key.kind !== "archive") throw new Error("expected archive key");
      const otherSha = otherSnap.key.sha256;
      const raw = await publishArchive(fixture, "raw-unindexed");

      const lockfile = join(fixture.root, "app", ".lando.lock.yml");
      await mkdir(dirname(lockfile), { recursive: true });
      await writeFile(lockfile, "includes: []\n");
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(lockfile)));

      for (const id of [protectedCommit, freeCommit]) {
        await ageEntryRelativeToClock(fixture.root, "git", id, 90_000);
      }
      for (const id of [npmA.sha256, otherSha, raw.sha256]) {
        await ageEntryRelativeToClock(fixture.root, "archive", id, 90_000);
      }

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: okLockKeys([
          { kind: "git", commit: protectedCommit },
          { kind: "npm", name: "locked-pkg", version: "2.0.0" },
        ]),
      });

      expect(report.reachability).toBe("complete");
      expect(report.roots).toEqual([{ lockfile, status: "ok" }]);
      expect(findEntry(report, "git", protectedCommit)).toMatchObject({
        protected: true,
        eligible: false,
        outcome: "kept",
        reason: "referenced",
      });
      expect(findEntry(report, "git", freeCommit)).toMatchObject({
        protected: false,
        eligible: true,
        outcome: "kept",
      });
      expect(findEntry(report, "archive", npmA.sha256)).toMatchObject({
        protected: true,
        eligible: false,
        outcome: "kept",
      });
      expect(findEntry(report, "archive", otherSha)).toMatchObject({
        protected: true,
        eligible: false,
        outcome: "kept",
      });
      expect(findEntry(report, "archive", raw.sha256)).toMatchObject({
        protected: false,
        eligible: true,
        outcome: "kept",
      });
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("corrupt/unreadable lockfiles mark reachability incomplete and withhold git plus npm-indexed archives only", async () => {
    const fixture = await makeGcFixture();
    try {
      const gitCommit = "e".repeat(40);
      await publishGit(fixture, gitCommit);
      const npm = await publishNpm(fixture, "withheld-pkg", "1.0.0", "w");
      const raw = await publishArchive(fixture, "raw-still-prunable");

      const badLock = join(fixture.root, "bad", ".lando.lock.yml");
      await mkdir(dirname(badLock), { recursive: true });
      await writeFile(badLock, "not-a-lock\n");
      await Effect.runPromise(withTestSession(fixture.store, (session) => session.registerRoot(badLock)));

      await ageEntryRelativeToClock(fixture.root, "git", gitCommit, 10_000);
      await ageEntryRelativeToClock(fixture.root, "archive", npm.sha256, 10_000);
      await ageEntryRelativeToClock(fixture.root, "archive", raw.sha256, 10_000);

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: (lockfile) =>
          lockfile === badLock
            ? Effect.succeed({ status: "corrupt", detail: "parse failed" })
            : Effect.succeed({ status: "missing" }),
      });

      expect(report.reachability).toBe("incomplete");
      expect(report.roots.some((r) => r.lockfile === badLock && r.status === "corrupt")).toBe(true);
      expect(findEntry(report, "git", gitCommit)).toMatchObject({
        outcome: "withheld",
        eligible: false,
      });
      expect(findEntry(report, "archive", npm.sha256)).toMatchObject({
        outcome: "withheld",
        eligible: false,
      });
      expect(findEntry(report, "archive", raw.sha256)).toMatchObject({
        outcome: "kept",
        eligible: true,
      });
    } finally {
      await disposeGcFixture(fixture);
    }
  });
});
