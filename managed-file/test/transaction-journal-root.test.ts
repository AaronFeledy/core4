import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ensureDirectory } from "../src/transaction-fs.ts";
import { journalDirectory } from "../src/transaction-journal.ts";
import { makeManagedFileTransactions } from "../src/transaction.ts";
import { fixture, ownerOnlyFileAccess, scoped } from "./transaction-fixture.ts";

const aliasedFixture = async () => {
  const context = await fixture();
  const real = join(context.root, "real");
  const alias = join(context.root, "alias");
  await mkdir(real);
  await symlink(real, alias, "dir");
  const transactions = makeManagedFileTransactions({
    journalRoot: () => join(alias, "data"),
    privateFileAccess: ownerOnlyFileAccess,
  });
  return { ...context, real, transactions };
};

test("prepares and commits when the journal root has a symlinked ancestor", async () => {
  // Given a lexical user-data root below an alias and a missing data directory
  const { appRoot, real, transactions } = await aliasedFixture();
  // When preparation persists a journal and the same scope commits it
  const prepared = await scoped(
    Effect.gen(function* () {
      const prepared = yield* transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: "output", content: "published" }],
      });
      yield* Effect.promise(async () => {
        const path = join(journalDirectory(appRoot, join(real, "data")), "transaction.json");
        expect(JSON.parse(await readFile(path, "utf8")).data.state).toBe("prepared");
      });
      yield* transactions.commit(prepared);
      return prepared;
    }),
  );
  // Then publication used the real tree, not the lexical alias
  expect(prepared.journalPath.startsWith(`${join(real, "data")}/`)).toBe(true);
  expect(await readFile(join(appRoot, "output"), "utf8")).toBe("published");
});

test("reads and recovers the prepared journal through the same aliased user-data root", async () => {
  // Given a durable prepared journal below a lexical user-data root
  const { appRoot, transactions } = await aliasedFixture();
  const prepared = await scoped(
    transactions.prepare({ appRoot, operations: [{ kind: "write", path: "output", content: "recovered" }] }),
  );
  // When inspection and recovery locate the retained journal
  const journal = await scoped(transactions.readJournal(appRoot));
  const pending = await scoped(transactions.pending(appRoot));
  const outcome = await scoped(transactions.recover(appRoot));
  // Then all entry points agree on the prepared transaction
  expect(journal?.id).toBe(prepared.id);
  expect(pending?.id).toBe(prepared.id);
  expect(outcome).toEqual({ id: prepared.id, action: "recovered" });
  expect(await readFile(join(appRoot, "output"), "utf8")).toBe("recovered");
});

for (const component of ["managed-files", "app-journal"] as const) {
  test(`rejects a symlinked ${component} below the canonical user-data root`, async () => {
    // Given a journal subtree redirected outside its user-data root
    const { root, appRoot, dataRoot, transactions } = await fixture();
    const destination = join(root, "outside");
    await mkdir(destination);
    const path =
      component === "managed-files" ? join(dataRoot, "managed-files") : journalDirectory(appRoot, dataRoot);
    if (component === "app-journal") await mkdir(join(dataRoot, "managed-files"));
    await symlink(destination, path, "dir");
    // When preparation encounters that component
    const result = await scoped(Effect.result(transactions.prepare({ appRoot, operations: [] })));
    // Then it fails closed with the existing path reason
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ManagedFileTransactionError", reason: "path" },
    });
    expect(await readdir(destination)).toEqual([]);
  });
}

test("rejects a journal directory outside its canonical boundary", async () => {
  // Given a directory whose ancestors never reach the requested boundary
  const { root } = await fixture();
  // When the bounded walk reaches the filesystem root
  const result = ensureDirectory(join(root, "outside", "journal"), join(root, "boundary"));
  // Then it fails closed instead of walking past the root
  await expect(result).rejects.toMatchObject({ _tag: "ManagedFileTransactionError", reason: "path" });
});
