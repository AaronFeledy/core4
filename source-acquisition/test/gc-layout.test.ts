import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  ageEntryRelativeToClock,
  disposeGcFixture,
  emptyLockKeys,
  entryDirPath,
  findEntry,
  leftoverOf,
  makeGcFixture,
  publishArchive,
  reapDeadPid,
  runGc,
  writeAgedLeftoverDir,
} from "./gc-support.ts";

const CHILD_SCRIPT = fileURLToPath(new URL("./fixtures/gc-child.ts", import.meta.url));
const CHILD_READY = "GC_CHILD_READY";
const CHILD_READY_TIMEOUT_MS = 15_000;

const readLineWithTimeout = async (
  reader: {
    readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>;
  },
  expected: string,
  timeoutMs: number,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true, value: undefined }), remaining);
      }),
    ]);
    if (result.done && result.value === undefined && !buffer.includes(expected)) {
      throw new Error(
        `Timed out waiting for child line ${JSON.stringify(expected)}; got ${JSON.stringify(buffer)}`,
      );
    }
    if (result.value !== undefined) buffer += decoder.decode(result.value, { stream: true });
    if (buffer.includes(`${expected}\n`) || buffer.trimEnd() === expected) return;
    if (result.done) {
      throw new Error(`Child stdout ended before ${JSON.stringify(expected)}; got ${JSON.stringify(buffer)}`);
    }
  }
  throw new Error(
    `Timed out waiting for child line ${JSON.stringify(expected)}; got ${JSON.stringify(buffer)}`,
  );
};

describe("source-acquisition store.gc layout and failure paths", () => {
  test("entry path that is a symlink is invalid and age-eligible", async () => {
    const fixture = await makeGcFixture();
    try {
      const id = "a".repeat(64);
      await mkdir(join(fixture.root, "archive"), { recursive: true });
      const target = join(fixture.root, "symlink-target");
      await mkdir(target, { recursive: true });
      await symlink(target, join(fixture.root, "archive", id));

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(findEntry(report, "archive", id)).toMatchObject({
        valid: false,
        eligible: true,
        outcome: "kept",
      });
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("symlink parent for archive kind fails inventory without following the link", async () => {
    const fixture = await makeGcFixture();
    try {
      const outside = join(fixture.root, "outside-archive");
      await mkdir(outside, { recursive: true });
      const decoyId = "c".repeat(64);
      // Decoy only exists behind the symlink parent; GC must not inventory it.
      await mkdir(join(outside, decoyId, "tree"), { recursive: true });
      await symlink(outside, join(fixture.root, "archive"));

      const report = await runGc(fixture.store, {
        prune: false,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      // names() refuses symlink parents -> inventory leftover failure for the kind.
      const inventory = leftoverOf(report, "inventory", "archive")[0];
      expect(inventory).toMatchObject({
        outcome: "failed",
        eligible: false,
      });
      expect(report.entries.some((e) => e.id === decoyId)).toBe(false);
    } finally {
      await disposeGcFixture(fixture);
    }
  });

  test("per-item leftover erase failure is reported failed and does not abort the run", async () => {
    const fixture = await makeGcFixture();
    try {
      const deadPid = await reapDeadPid();
      const blocked = `.staging-${deadPid}-${crypto.randomUUID()}`;
      const removable = `.gc-${deadPid}-${crypto.randomUUID()}`;
      await writeAgedLeftoverDir(fixture.root, blocked, 1_000);
      await writeAgedLeftoverDir(fixture.root, removable, 1_000);

      // Drop write on the store root so rename-to-aside fails for leftovers.
      await chmod(fixture.root, 0o555);
      let report: Awaited<ReturnType<typeof runGc>>;
      try {
        report = await runGc(fixture.store, {
          prune: true,
          olderThanMs: 0,
          readLockKeys: emptyLockKeys,
        });
      } finally {
        await chmod(fixture.root, 0o755);
      }

      expect(leftoverOf(report, "staging", blocked)[0]).toMatchObject({
        eligible: true,
        outcome: "failed",
      });
      expect(leftoverOf(report, "gc", removable)[0]).toMatchObject({
        eligible: true,
        outcome: "failed",
      });
      expect(report.totals.failed).toBe(2);
      // Run completed a full report (did not abort) and left both paths on disk.
      expect(report.prune).toBe(true);
      await access(join(fixture.root, blocked));
      await access(join(fixture.root, removable));
    } finally {
      await chmod(fixture.root, 0o755);
      await disposeGcFixture(fixture);
    }
  });

  test("cross-process live lease marks the entry busy; after child exit the aged entry is eligible", async () => {
    const fixture = await makeGcFixture();
    try {
      const archive = await publishArchive(fixture, "leased-cross");
      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 120_000);

      const child = Bun.spawn({
        cmd: [process.execPath, CHILD_SCRIPT, fixture.root, archive.sha256],
        cwd: dirname(CHILD_SCRIPT),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: { ...process.env },
      });

      if (child.stdout === null || child.stdin === null) {
        child.kill();
        throw new Error("child pipes unavailable");
      }
      const reader = child.stdout.getReader();
      try {
        await readLineWithTimeout(reader, CHILD_READY, CHILD_READY_TIMEOUT_MS);

        // Wall clock + olderThan 0: live child lease must busy the entry.
        const busyReport = await Effect.runPromise(
          fixture.store.gc({
            prune: true,
            olderThanMs: 0,
            readLockKeys: emptyLockKeys,
          }),
        );
        expect(findEntry(busyReport, "archive", archive.sha256)).toMatchObject({
          leased: true,
          eligible: false,
          outcome: "busy",
        });
        await access(entryDirPath(fixture.root, "archive", archive.sha256));

        child.stdin.write("done\n");
        await child.stdin.end();
      } finally {
        reader.releaseLock();
      }

      const exitCode = await child.exited;
      const stderr = child.stderr === null ? "" : await new Response(child.stderr).text();
      if (exitCode !== 0) throw new Error(`gc-child exited ${exitCode}: ${stderr}`);

      await ageEntryRelativeToClock(fixture.root, "archive", archive.sha256, 60_000);
      const after = await runGc(fixture.store, {
        prune: true,
        olderThanMs: 0,
        readLockKeys: emptyLockKeys,
      });
      expect(findEntry(after, "archive", archive.sha256)).toMatchObject({
        leased: false,
        eligible: true,
        outcome: "removed",
      });
      await expect(access(entryDirPath(fixture.root, "archive", archive.sha256))).rejects.toBeDefined();
    } finally {
      await disposeGcFixture(fixture);
    }
  });
});
