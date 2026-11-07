import { describe, expect, test } from "bun:test";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SourceGcReportSchema } from "@lando/source-acquisition/gc";
import { Effect, Schema } from "effect";
import { sourceRecords } from "../src/records.ts";
import {
  disposeGcFixture,
  emptyLockKeys,
  leftoverOf,
  makeGcFixture,
  reapDeadPid,
  runGc,
  statusLockKeys,
  writeAgedLeftoverDir,
  writeLeaseFile,
  writeLeftoverDir,
} from "./gc-support.ts";

describe("source-acquisition store.gc leftovers and leases", () => {
  test("dead pid leftovers prune; live pid stay busy; unparseable require age before prune", async () => {
    const fixture = await makeGcFixture();
    try {
      const deadPid = await reapDeadPid();
      const deadStaging = `.staging-${deadPid}-${crypto.randomUUID()}`;
      const liveStaging = `.staging-${process.pid}-${crypto.randomUUID()}`;
      const unparseable = `.replaced-notapid-${crypto.randomUUID()}`;
      const deadGc = `.gc-${deadPid}-${crypto.randomUUID()}`;

      await writeLeftoverDir(fixture.root, deadStaging);
      await writeLeftoverDir(fixture.root, liveStaging);
      // Unparseable names have no dead pid: eligibility is age-only vs virtual clock.
      await writeAgedLeftoverDir(fixture.root, unparseable, 60_000);
      await writeLeftoverDir(fixture.root, deadGc);

      const reportOnly = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(leftoverOf(reportOnly, "staging", deadStaging)[0]).toMatchObject({
        eligible: true,
        outcome: "kept",
        pid: deadPid,
      });
      expect(leftoverOf(reportOnly, "staging", liveStaging)[0]).toMatchObject({
        eligible: false,
        outcome: "busy",
        pid: process.pid,
      });
      expect(leftoverOf(reportOnly, "replaced", unparseable)[0]).toMatchObject({
        eligible: true,
        outcome: "kept",
      });
      expect(leftoverOf(reportOnly, "gc", deadGc)[0]).toMatchObject({
        eligible: true,
        outcome: "kept",
        pid: deadPid,
      });

      const pruned = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(leftoverOf(pruned, "staging", deadStaging)[0].outcome).toBe("removed");
      expect(leftoverOf(pruned, "staging", liveStaging)[0].outcome).toBe("busy");
      expect(leftoverOf(pruned, "replaced", unparseable)[0].outcome).toBe("removed");
      expect(leftoverOf(pruned, "gc", deadGc)[0].outcome).toBe("removed");

      await expect(access(join(fixture.root, deadStaging))).rejects.toBeDefined();
      await access(join(fixture.root, liveStaging));
      await expect(access(join(fixture.root, unparseable))).rejects.toBeDefined();
      await expect(access(join(fixture.root, deadGc))).rejects.toBeDefined();
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("unparseable leftover younger than cutoff stays ineligible", async () => {
    const fixture = await makeGcFixture();
    try {
      const unparseable = `.staging-notapid-${crypto.randomUUID()}`;
      await writeAgedLeftoverDir(fixture.root, unparseable, 1_000);

      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 60_000,
        readLockKeys: emptyLockKeys,
      });
      expect(leftoverOf(report, "staging", unparseable)[0]).toMatchObject({
        eligible: false,
        outcome: "kept",
      });
      await access(join(fixture.root, unparseable));
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("dead lease files are eligible and removed; malformed leases fail closed and stay", async () => {
    const fixture = await makeGcFixture();
    try {
      const deadPid = await reapDeadPid();
      await writeLeaseFile(fixture.root, "dead.json", {
        pid: deadPid,
        token: "x",
        createdAt: 0,
        keys: [{ kind: "archive", sha256: "f".repeat(64) }],
      });
      await writeLeaseFile(fixture.root, "garbage.json", "not-json{{{");

      const reportOnly = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      const dead = leftoverOf(reportOnly, "lease", "dead.json")[0];
      const garbage = leftoverOf(reportOnly, "lease", "garbage.json")[0];
      expect(dead).toMatchObject({
        eligible: true,
        outcome: "kept",
        reason: "dead-lease",
        pid: deadPid,
      });
      // Malformed leases are conservative: not eligible, failed (withhold from prune).
      expect(garbage).toMatchObject({
        eligible: false,
        outcome: "failed",
      });
      expect(typeof garbage.reason).toBe("string");
      expect((garbage.reason ?? "").length).toBeGreaterThan(0);

      const pruned = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(leftoverOf(pruned, "lease", "dead.json")[0]).toMatchObject({
        eligible: true,
        outcome: "removed",
      });
      expect(leftoverOf(pruned, "lease", "garbage.json")[0]).toMatchObject({
        eligible: false,
        outcome: "failed",
      });
      const remaining = await readdir(join(fixture.root, ".leases"));
      expect(remaining).toEqual(["garbage.json"]);
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("leftovers schema permits staging/replaced/gc/lease/npm-index/ref/root kinds", async () => {
    const fixture = await makeGcFixture();
    try {
      const deadPid = await reapDeadPid();
      await writeAgedLeftoverDir(fixture.root, `.staging-${deadPid}-${crypto.randomUUID()}`, 1_000);
      await writeAgedLeftoverDir(fixture.root, `.replaced-${deadPid}-${crypto.randomUUID()}`, 1_000);
      await writeAgedLeftoverDir(fixture.root, `.gc-${deadPid}-${crypto.randomUUID()}`, 1_000);
      await writeLeaseFile(fixture.root, "x.json", {
        pid: deadPid,
        token: "t",
        createdAt: 0,
        keys: [],
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const npm = yield* sourceRecords(fixture.stateStore).npm("https://r.test/", "n", "1.0.0");
          yield* npm.set({
            name: "n",
            version: "1.0.0",
            registry: "https://r.test/",
            sha256: "4".repeat(64),
          });
          const ref = yield* sourceRecords(fixture.stateStore).ref("https://g.test/r.git", "HEAD");
          yield* ref.set({ commit: "5".repeat(40) });
          const root = yield* sourceRecords(fixture.stateStore).root("/missing/lock.yml");
          yield* root.set({ lockfile: "/missing/lock.yml", updatedAt: 1 });
        }),
      );

      const report = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: statusLockKeys({ status: "missing" }),
      });
      const kinds = new Set(report.leftovers.map((l) => l.kind));
      for (const kind of ["staging", "replaced", "gc", "lease", "npm-index", "ref", "root"] as const) {
        if (!kinds.has(kind)) {
          throw new Error(`missing leftover kind ${kind}; have ${[...kinds].join(",")}`);
        }
      }
      Schema.decodeUnknownSync(SourceGcReportSchema)(report);
    } finally {
      await disposeGcFixture(fixture);
    }
  });
});
