import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

const stageOf = async (appRoot: string): Promise<string> => {
  const name = (await readdir(appRoot)).find((entry) => entry.includes(".lando-stage."));
  if (name === undefined) throw new Error("missing stage");
  return join(appRoot, name);
};

/** One mixed plan: overwrite an existing file, create an absent one, remove a third. */
const mixedFixture = async (stopAt: string) => {
  const context = await fixture((at, index) =>
    at === stopAt && (index === -1 || index === 0) ? Effect.fail("crash") : Effect.void,
  );
  await writeFile(join(context.appRoot, "keep"), "old-keep", { mode: 0o640 });
  await writeFile(join(context.appRoot, "drop"), "old-drop");
  const result = await scoped(
    Effect.either(
      context.transactions.run({
        appRoot: context.appRoot,
        operations: [
          { kind: "write", path: "keep", content: "new-keep" },
          { kind: "write", path: "fresh", content: "new-fresh" },
          { kind: "remove", path: "drop" },
        ],
      }),
    ),
  );
  expect(result._tag).toBe("Left");
  return context;
};

test("rolls a prepared journal forward across write, create, and removal entries", async () => {
  // Given a crash immediately after the prepared journal became durable
  const { appRoot, transactions } = await mixedFixture("prepared");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("prepared");
  // When recovery runs
  const outcome = await scoped(transactions.recover(appRoot));
  // Then every after-state is published, backups survive, and the journal is gone
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
  expect(await readFile(join(appRoot, "fresh"), "utf8")).toBe("new-fresh");
  await expect(lstat(join(appRoot, "drop"))).rejects.toMatchObject({ code: "ENOENT" });
  const names = await readdir(appRoot);
  expect(names.filter((name) => name.includes(".lando-stage."))).toHaveLength(0);
  expect(names.filter((name) => name.includes(".bak."))).toHaveLength(2);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
  if (process.platform !== "win32") expect((await lstat(join(appRoot, "keep"))).mode & 0o777).toBe(0o640);
});

test("mutates only the unapplied entries of an interrupted commit", async () => {
  // Given a commit interrupted after publishing its first target
  const { appRoot, transactions } = await mixedFixture("after-mutation");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("committing");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
  await expect(lstat(join(appRoot, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
  // When recovery classifies the applied entry and finishes the rest
  const outcome = await scoped(transactions.recover(appRoot));
  // Then the remaining entries land without disturbing the applied one
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
  expect(await readFile(join(appRoot, "fresh"), "utf8")).toBe("new-fresh");
  await expect(lstat(join(appRoot, "drop"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("completes an output mode whose rename landed before its chmod", async () => {
  // Given a published target still wearing its stage's owner-only mode
  const { appRoot, transactions } = await mixedFixture("after-mutation");
  if (process.platform === "win32") return;
  await chmod(join(appRoot, "keep"), 0o600);
  // When recovery inspects that window
  const outcome = await scoped(transactions.recover(appRoot));
  // Then it applies the recorded output mode instead of calling it a conflict
  expect(outcome?.action).toBe("recovered");
  expect((await lstat(join(appRoot, "keep"))).mode & 0o777).toBe(0o640);
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
});

for (const variant of [
  "target-content",
  "target-mode",
  "unexpected-present",
  "target-symlink",
  "backup-missing",
  "backup-modified",
  "stage-missing",
  "stage-content",
  "stage-mode",
] as const) {
  test(`blocks recovery and preserves every file when ${variant} conflicts`, async () => {
    // Given a durable prepared plan and one preflight mismatch
    const { appRoot, transactions } = await mixedFixture("prepared");
    if (process.platform === "win32" && (variant === "target-mode" || variant === "stage-mode")) return;
    const keep = join(appRoot, "keep");
    const backup = (await readdir(appRoot)).find((name) => name.startsWith("keep.bak."));
    if (backup === undefined) throw new Error("missing backup");
    const stage = await stageOf(appRoot);
    switch (variant) {
      case "target-content":
        await writeFile(keep, "concurrent", { mode: 0o640 });
        break;
      case "target-mode":
        await chmod(keep, 0o600);
        break;
      case "unexpected-present":
        await writeFile(join(appRoot, "fresh"), "planted");
        break;
      case "target-symlink":
        await rm(keep);
        await symlink(join(appRoot, "drop"), keep);
        break;
      case "backup-missing":
        await rm(join(appRoot, backup));
        break;
      case "backup-modified":
        await writeFile(join(appRoot, backup), "tampered", { mode: 0o600 });
        break;
      case "stage-missing":
        await rm(stage);
        break;
      case "stage-content":
        await writeFile(stage, "tampered", { mode: 0o600 });
        break;
      case "stage-mode":
        await chmod(stage, 0o644);
        break;
    }
    const before = await readdir(appRoot);
    // When recovery preflights the recorded plan
    const outcome = await scoped(Effect.either(transactions.recover(appRoot)));
    // Then it blocks for manual resolution without touching a single user file
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left.reason).toBe("blocked");
    expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
    expect((await readdir(appRoot)).toSorted()).toEqual(before.toSorted());
    if (variant !== "target-content" && variant !== "target-symlink" && variant !== "target-mode")
      expect(await readFile(keep, "utf8")).toBe("old-keep");
    expect(await readFile(join(appRoot, "drop"), "utf8")).toBe("old-drop");
    // And a blocked journal keeps refusing rather than retrying
    const retry = await scoped(Effect.either(transactions.recover(appRoot)));
    expect(retry._tag).toBe("Left");
  });
}

test("never restores a backup over an edit made to an already applied target", async () => {
  // Given an interrupted commit whose applied target is edited afterwards
  const { appRoot, transactions } = await mixedFixture("after-mutation");
  await writeFile(join(appRoot, "keep"), "user-edit", { mode: 0o640 });
  // When recovery preflights the mixed state
  const outcome = await scoped(Effect.either(transactions.recover(appRoot)));
  // Then the edit survives, the pending target stays untouched, and it blocks
  expect(outcome._tag).toBe("Left");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("user-edit");
  await expect(lstat(join(appRoot, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(appRoot, "drop"), "utf8")).toBe("old-drop");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
});

test("cleans a committed journal without inspecting or restoring targets", async () => {
  // Given a commit that crashed after its durable committed record
  const { appRoot, transactions } = await mixedFixture("committed");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("committed");
  await writeFile(join(appRoot, "keep"), "later-edit", { mode: 0o640 });
  // When recovery handles the committed state
  const outcome = await scoped(transactions.recover(appRoot));
  // Then it only removes verified stages and the journal
  expect(outcome?.action).toBe("cleaned");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("later-edit");
  const names = await readdir(appRoot);
  expect(names.filter((name) => name.includes(".lando-stage."))).toHaveLength(0);
  expect(names.filter((name) => name.includes(".bak."))).toHaveLength(2);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});

test("preserves a foreign stage that reused a recorded path", async () => {
  // Given a committed transaction whose stage path was refilled by someone else
  const { appRoot, transactions } = await mixedFixture("committed");
  const journal = await scoped(transactions.readJournal(appRoot));
  const stage = journal?.entries.find((entry) => entry.stage !== undefined)?.stage;
  if (stage === undefined) throw new Error("missing stage");
  await writeFile(stage.path, "foreign");
  // When committed cleanup runs
  await scoped(transactions.recover(appRoot));
  // Then the unowned inode is preserved
  expect(await readFile(stage.path, "utf8")).toBe("foreign");
});

test("reports pending recovery without creating or mutating anything", async () => {
  // Given an app root that never ran a transaction
  const { appRoot, dataRoot, transactions } = await fixture();
  // When the dry run inspects it
  expect(await scoped(transactions.pending(appRoot))).toBeNull();
  // Then no journal directory was created
  expect(await readdir(dataRoot)).toEqual([]);
  // And a real prepared plan is reported by state, action, and targets only
  await writeFile(join(appRoot, "keep"), "old-keep");
  const prepared = await scoped(
    transactions.prepare({
      appRoot,
      operations: [{ kind: "write", path: "keep", content: "new-keep" }],
    }),
  );
  const snapshot = await readdir(appRoot);
  const report = await scoped(transactions.pending(appRoot));
  expect(report).toEqual({ id: prepared.id, state: "prepared", action: "recover", targets: ["keep"] });
  expect(JSON.stringify(report)).not.toContain("new-keep");
  expect((await readdir(appRoot)).toSorted()).toEqual(snapshot.toSorted());
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("prepared");
});

test("reports the action a blocked or committed journal needs", async () => {
  // Given a blocked journal produced by a real conflict
  const { appRoot, transactions } = await mixedFixture("prepared");
  await writeFile(join(appRoot, "keep"), "concurrent", { mode: 0o640 });
  await scoped(Effect.either(transactions.recover(appRoot)));
  // When the dry run inspects it
  const report = await scoped(transactions.pending(appRoot));
  // Then it names manual resolution instead of recovery
  expect(report?.state).toBe("blocked");
  expect(report?.action).toBe("manual-resolution");
  expect(report?.targets).toEqual(["drop", "fresh", "keep"]);
});

test("recovers under the same cooperative canonical-root lock", async () => {
  // Given a prepared journal reachable through a symlinked spelling of its root
  const { root, appRoot, transactions } = await mixedFixture("prepared");
  const alias = join(root, "alias");
  await symlink(appRoot, alias);
  // When recovery runs against the alias while nothing else holds the lock
  const outcome = await scoped(transactions.recover(alias));
  // Then it resolves to the same canonical journal and completes it
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "fresh"), "utf8")).toBe("new-fresh");
  // And no journal remains under either spelling of that root
  expect(await scoped(transactions.readJournal(alias))).toBeNull();
});

test("refuses to consume a partial set through the guard entry point", async () => {
  // Given a blocked transaction under an app root
  const { appRoot, transactions } = await mixedFixture("prepared");
  await writeFile(join(appRoot, "keep"), "concurrent", { mode: 0o640 });
  await scoped(Effect.either(transactions.recover(appRoot)));
  // When the load/start guard checks that root
  const guarded = await Effect.runPromise(Effect.either(transactions.ensureConsistent(appRoot)));
  // Then it refuses without loading anything else
  expect(guarded._tag).toBe("Left");
  if (guarded._tag === "Left") expect(guarded.left.reason).toBe("blocked");
});

test("passes a clean app root through the guard without creating journal state", async () => {
  // Given an app root with no transaction history
  const { root, appRoot, dataRoot, transactions } = await fixture();
  const nested = join(appRoot, "nested");
  await mkdir(nested);
  // When the guard checks it
  await Effect.runPromise(transactions.ensureConsistent(nested));
  // Then nothing was created and the check is cheap
  expect(await readdir(dataRoot)).toEqual([]);
  expect(await readdir(appRoot)).toEqual(["nested"]);
  expect(dirname(nested)).toBe(appRoot);
  expect(root).toContain("lando-transaction-");
});

test("resumes a recovery that was itself interrupted mid-plan", async () => {
  // Given a prepared plan whose recovery dies after publishing one entry
  let interruptRecovery = true;
  const { appRoot, transactions } = await fixture((at, index) => {
    if (at === "prepared") return Effect.fail("crash");
    if (at !== "after-recovery-mutation" || index !== 0 || !interruptRecovery) return Effect.void;
    interruptRecovery = false;
    return Effect.fail("crash");
  });
  await writeFile(join(appRoot, "keep"), "old-keep");
  await scoped(
    Effect.either(
      transactions.run({
        appRoot,
        operations: [
          { kind: "write", path: "keep", content: "new-keep" },
          { kind: "write", path: "fresh", content: "new-fresh" },
        ],
      }),
    ),
  );
  const first = await scoped(Effect.either(transactions.recover(appRoot)));
  expect(first._tag).toBe("Left");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("committing");
  // When recovery runs again against the surviving journal
  const outcome = await scoped(transactions.recover(appRoot));
  // Then the plan completes exactly once
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
  expect(await readFile(join(appRoot, "fresh"), "utf8")).toBe("new-fresh");
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});
