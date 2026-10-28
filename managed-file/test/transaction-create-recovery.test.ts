import { expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

const expectMode = async (path: string, mode: number): Promise<void> => {
  const actual = await modeOf(path);
  if (process.platform === "win32") {
    expect((actual & 0o200) !== 0).toBe((mode & 0o200) !== 0);
    return;
  }
  expect(actual).toBe(mode);
};

const stageName = async (directory: string): Promise<string> => {
  const name = (await readdir(directory)).find((entry) => entry.includes(".lando-stage."));
  if (name === undefined) throw new Error("missing stage");
  return name;
};

test("finishes a crash after link and before stage unlink", async () => {
  // Given a create interrupted while the stage and target still share an inode
  const { appRoot, transactions } = await fixture((at) =>
    at === "create-linked" ? Effect.fail("crash") : Effect.void,
  );
  const failed = await scoped(
    Effect.result(
      transactions.run({
        appRoot,
        operations: [{ kind: "create", path: "a", content: "LINKED", mode: 0o640 }],
      }),
    ),
  );
  expect(failed._tag).toBe("Failure");
  const target = await lstat(join(appRoot, "a"));
  const stage = await lstat(join(appRoot, await stageName(appRoot)));
  expect(target.ino).toBe(stage.ino);
  if (process.platform !== "win32") expect(target.nlink).toBe(2);

  // When a later recovery runs
  const outcome = await scoped(transactions.recover(appRoot));

  // Then one name remains, with the requested bytes and mode
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe("LINKED");
  await expectMode(join(appRoot, "a"), 0o640);
  expect((await readdir(appRoot)).filter((name) => name.includes(".lando-stage."))).toHaveLength(0);
  if (process.platform !== "win32") expect((await lstat(join(appRoot, "a"))).nlink).toBe(1);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});

test("recovers a published inode after the stage name is already gone", async () => {
  // Given a create that linked, chmodded, and unlinked the stage before the journal committed
  const { appRoot, transactions } = await fixture((at, index) =>
    at === "after-mutation" && index === 0 ? Effect.fail("crash") : Effect.void,
  );
  await scoped(
    Effect.result(
      transactions.run({ appRoot, operations: [{ kind: "create", path: "a", content: "PUBLISHED" }] }),
    ),
  );
  const inode = (await lstat(join(appRoot, "a"))).ino;
  expect((await readdir(appRoot)).filter((name) => name.includes(".lando-stage."))).toHaveLength(0);

  // When recovery runs in-process
  const outcome = await scoped(transactions.recover(appRoot));

  // Then the same inode is kept
  expect(outcome?.action).toBe("recovered");
  expect((await lstat(join(appRoot, "a"))).ino).toBe(inode);
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe("PUBLISHED");
});

test("blocks when a same-digest file is a different inode", async () => {
  // Given a published create whose inode was replaced by the same bytes
  const content = "SAME-BYTES";
  const { appRoot, transactions } = await fixture((at, index) =>
    at === "after-mutation" && index === 0
      ? Effect.promise(async () => {
          // Retain the original inode so the filesystem cannot reuse it for the replacement.
          await rename(join(appRoot, "a"), join(appRoot, "original"));
          await writeFile(join(appRoot, "a"), content);
          await chmod(join(appRoot, "a"), 0o644);
        }).pipe(Effect.andThen(Effect.fail("crash")))
      : Effect.void,
  );
  await scoped(
    Effect.result(transactions.run({ appRoot, operations: [{ kind: "create", path: "a", content }] })),
  );
  const inode = (await lstat(join(appRoot, "a"))).ino;
  expect(inode).not.toBe((await lstat(join(appRoot, "original"))).ino);
  await expectMode(join(appRoot, "a"), 0o644);

  // When recovery is asked to adopt that file
  const outcome = await scoped(Effect.result(transactions.recover(appRoot)));

  // Then digest equality is not ownership
  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("blocked");
  expect((await lstat(join(appRoot, "a"))).ino).toBe(inode);
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe(content);
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
});

test("rejects a third hardlink without unlinking it", async () => {
  // Given an extra name linked to the stage/target pair before stage unlink
  const { appRoot, transactions } = await fixture((at) =>
    at === "create-linked"
      ? Effect.promise(() => link(join(appRoot, "a"), join(appRoot, "extra")))
      : Effect.void,
  );
  await scoped(
    Effect.result(
      transactions.run({ appRoot, operations: [{ kind: "create", path: "a", content: "SHARED" }] }),
    ),
  );
  const inode = (await lstat(join(appRoot, "a"))).ino;

  // When recovery sees the extra link
  const outcome = await scoped(Effect.result(transactions.recover(appRoot)));

  // Then every name remains
  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("blocked");
  expect((await lstat(join(appRoot, "extra"))).ino).toBe(inode);
  expect(await readFile(join(appRoot, "extra"), "utf8")).toBe("SHARED");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe("SHARED");
  if (process.platform !== "win32") expect((await lstat(join(appRoot, "a"))).nlink).toBeGreaterThan(2);
});

test("blocks drift of a published prefix and does not publish the rest", async () => {
  // Given the first create committed and then edited before the second link
  const { appRoot, transactions } = await fixture((at, index) =>
    at === "after-mutation" && index === 0
      ? Effect.promise(() => writeFile(join(appRoot, "a"), "DRIFTED")).pipe(
          Effect.andThen(Effect.fail("crash")),
        )
      : Effect.void,
  );
  await scoped(
    Effect.result(
      transactions.run({
        appRoot,
        operations: [
          { kind: "create", path: "a", content: "ORIGINAL-A" },
          { kind: "create", path: "b", content: "ORIGINAL-B" },
        ],
      }),
    ),
  );

  // When recovery preflights the prefix
  const outcome = await scoped(Effect.result(transactions.recover(appRoot)));

  // Then the drifted prefix stays and the later file is not invented
  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("blocked");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe("DRIFTED");
  await expect(lstat(join(appRoot, "b"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
});

test("recovers a linked create from a fresh process", async () => {
  // Given a durable 2-link window
  const { appRoot, dataRoot, transactions } = await fixture((at) =>
    at === "create-linked" ? Effect.fail("crash") : Effect.void,
  );
  await scoped(
    Effect.result(
      transactions.run({
        appRoot,
        operations: [{ kind: "create", path: "a", content: "FRESH-PROCESS-BYTES" }],
      }),
    ),
  );
  const script = `
    import { Effect } from "effect";
    import { makeManagedFileTransactions } from "@lando/managed-file/transaction";
    import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
    const appRoot = process.env.RECOVER_APP_ROOT;
    const dataRoot = process.env.RECOVER_DATA_ROOT;
    if (appRoot === undefined || dataRoot === undefined) throw new Error("missing roots");
    const access = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* PrivateFileAccessService;
        }).pipe(Effect.provide(PrivateFileAccessService.layer)),
      ),
    );
    const transactions = makeManagedFileTransactions({
      journalRoot: () => dataRoot,
      privateFileAccess: access,
    });
    const outcome = await Effect.runPromise(Effect.scoped(transactions.recover(appRoot)));
    process.stdout.write(JSON.stringify(outcome));
  `;

  // When another process reads the journal
  const child = Bun.spawn(["bun", "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, RECOVER_APP_ROOT: appRoot, RECOVER_DATA_ROOT: dataRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();

  // Then that process completes the publish without echoing file bytes
  expect({ code, stderr, stdout }).toMatchObject({ code: 0 });
  expect(JSON.parse(stdout).action).toBe("recovered");
  expect(stdout).not.toContain("FRESH-PROCESS-BYTES");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe("FRESH-PROCESS-BYTES");
  expect((await readdir(appRoot)).filter((name) => name.includes(".lando-stage."))).toHaveLength(0);
});

test("recovers a version 1 replace journal without create semantics", async () => {
  // Given a prepared replace whose envelope is still version 1
  const { appRoot, transactions } = await fixture();
  await writeFile(join(appRoot, "keep"), "old-keep");
  if (process.platform !== "win32") await chmod(join(appRoot, "keep"), 0o640);
  const prepared = await scoped(
    transactions.prepare({ appRoot, operations: [{ kind: "write", path: "keep", content: "new-keep" }] }),
  );
  const journal = await scoped(transactions.readJournal(appRoot));
  if (journal === null) throw new Error("missing journal");
  const data = {
    id: journal.id,
    root: journal.root,
    state: journal.state,
    entries: journal.entries.map((entry) => ({
      path: entry.path,
      before: entry.before,
      after: entry.after,
      ...(entry.stage === undefined ? {} : { stage: entry.stage }),
    })),
  };
  await writeFile(prepared.journalPath, `${JSON.stringify({ version: 1, data }, null, 2)}\n`);
  await chmod(prepared.journalPath, 0o600);

  // When the current coordinator recovers it
  const outcome = await scoped(transactions.recover(appRoot));

  // Then replace semantics publish the new bytes and keep the previous mode
  expect(outcome?.action).toBe("recovered");
  expect(await readFile(join(appRoot, "keep"), "utf8")).toBe("new-keep");
  if (process.platform !== "win32") expect(await modeOf(join(appRoot, "keep"))).toBe(0o640);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});

test("blocks recovery when a missing parent was replaced by a symlink", async () => {
  // Given a prepared nested create whose parent path is now a symlink
  const { appRoot, transactions } = await fixture((at) =>
    at === "prepared" ? Effect.fail("crash") : Effect.void,
  );
  await scoped(
    Effect.result(
      transactions.run({ appRoot, operations: [{ kind: "create", path: "nested/file", content: "NEW" }] }),
    ),
  );
  await mkdir(join(appRoot, "other"));
  await writeFile(join(appRoot, "other/keep"), "SAFE");
  await symlink(join(appRoot, "other"), join(appRoot, "nested"));

  // When recovery would otherwise create that parent
  const outcome = await scoped(Effect.result(transactions.recover(appRoot)));

  // Then the symlink target is untouched and the journal blocks
  expect(outcome._tag).toBe("Failure");
  if (outcome._tag === "Failure") expect(outcome.failure.reason).toBe("blocked");
  expect(await readFile(join(appRoot, "other/keep"), "utf8")).toBe("SAFE");
  await expect(lstat(join(appRoot, "other/file"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(appRoot, "nested"))).isSymbolicLink()).toBe(true);
});
