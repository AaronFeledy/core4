import { expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { sourceRecords } from "../src/records.ts";
import { withTestSession } from "../src/testing.ts";
import {
  ageEntryRelativeToClock,
  disposeGcFixture,
  emptyLockKeys,
  makeGcFixture,
  publishArchive,
  runGc,
} from "./gc-support.ts";

// Root bypasses directory mode bits, so it cannot reproduce EACCES.
test.skipIf(process.getuid?.() === 0)("GC reports inaccessible index targets after pruning", async () => {
  const fixture = await makeGcFixture();
  const git = join(fixture.root, "git");
  try {
    const archive = await publishArchive(fixture, "pruned-before-record-failure");
    await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 60_000);
    const ref = await Effect.runPromise(
      sourceRecords(fixture.stateStore).ref("https://git.test/example", "main"),
    );
    await Effect.runPromise(ref.set({ commit: "a".repeat(40) }));
    await mkdir(git);
    await chmod(git, 0);

    const report = await runGc(fixture.store, { prune: true, olderThanMs: 0, readLockKeys: emptyLockKeys });
    expect(report.entries).toMatchObject([{ id: archive.sha256, outcome: "removed" }]);
    expect(report.leftovers.filter((row) => row.kind === "ref")).toMatchObject([{ outcome: "failed" }]);
    expect(report.leftovers.find((row) => row.kind === "ref")?.reason).toContain("EACCES");
    expect(report.totals).toMatchObject({ removed: 1, failed: 2 });
  } finally {
    await chmod(git, 0o700);
    await disposeGcFixture(fixture);
  }
});

test.skipIf(process.getuid?.() === 0)("GC keeps removal totals when leftover inventory fails", async () => {
  const fixture = await makeGcFixture();
  try {
    const archive = await publishArchive(fixture, "removed-before-inventory-failure");
    await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 60_000);
    await Effect.runPromise(
      withTestSession(fixture.store, (session) => session.registerRoot("/app/.lando.lock.yml")),
    );
    let reads = 0;

    const report = await runGc(fixture.store, {
      prune: true,
      olderThanMs: 0,
      readLockKeys: () =>
        Effect.promise(async () => {
          reads++;
          if (reads === 2) await chmod(fixture.root, 0o300);
          return { status: "ok" as const, keys: [] };
        }),
    });
    expect(report.entries).toMatchObject([{ id: archive.sha256, outcome: "removed" }]);
    expect(report.leftovers.find((row) => row.id === "leftovers")).toMatchObject({ outcome: "failed" });
    expect(report.totals).toMatchObject({ removed: 1, failed: 2 });
  } finally {
    await chmod(fixture.root, 0o700);
    await disposeGcFixture(fixture);
  }
});
