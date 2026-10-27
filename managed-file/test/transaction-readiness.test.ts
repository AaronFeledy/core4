import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { makeManagedFileTransactionGuard } from "../src/transaction-guard.ts";
import { fixture, ownerOnlyFileAccess, scoped } from "./transaction-fixture.ts";

test.each(["prepared", "committing", "committed", "blocked"] as const)(
  "readiness inspects %s without recovery or cleanup",
  async (state) => {
    // Given: a real durable journal, stopped at its corresponding checkpoint.
    const stopAt = state === "blocked" ? "prepared" : state;
    const { appRoot, dataRoot, transactions } = await fixture((at) =>
      at === stopAt ? Effect.fail("interrupted") : Effect.void,
    );
    const path = join(appRoot, ".lando.yml");
    await writeFile(path, "name: before\n");
    await scoped(
      transactions
        .run({ appRoot, operations: [{ kind: "write", path: ".lando.yml", content: "name: after\n" }] })
        .pipe(Effect.result),
    );
    if (state === "blocked") {
      await writeFile(path, "name: external\n");
      await scoped(transactions.recover(appRoot).pipe(Effect.result));
    }
    const guard = makeManagedFileTransactionGuard({
      journalRoot: () => dataRoot,
      privateFileAccess: ownerOnlyFileAccess,
    });
    const before = await Bun.file(path).text();
    const files = await readdir(appRoot);
    const journal = await scoped(transactions.readJournal(appRoot));
    expect(journal?.state).toBe(state);
    // When
    const result = await Effect.runPromise(guard.assertReadable(appRoot).pipe(Effect.result));
    // Then
    if (state === "committed") expect(Result.isSuccess(result)).toBe(true);
    else
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "ManagedFileTransactionError",
        phase: "inspect",
        reason: state === "blocked" ? "blocked" : "pending-transaction",
      });
    expect(await Bun.file(path).text()).toBe(before);
    expect(await readdir(appRoot)).toEqual(files);
    expect(await scoped(transactions.readJournal(appRoot))).toEqual(journal);
  },
);

test("readiness admits a clean root without creating journal state", async () => {
  // Given
  const { appRoot, dataRoot } = await fixture();
  const guard = makeManagedFileTransactionGuard({
    journalRoot: () => dataRoot,
    privateFileAccess: ownerOnlyFileAccess,
  });
  // When
  await Effect.runPromise(guard.assertReadable(appRoot));
  // Then
  expect(await readdir(dataRoot)).toEqual([]);
});

test("ordinary readiness recovers a prepared transaction", async () => {
  // Given
  const { appRoot, dataRoot, transactions } = await fixture();
  await writeFile(join(appRoot, ".lando.yml"), "name: before\n");
  await scoped(
    transactions.prepare({
      appRoot,
      operations: [{ kind: "write", path: ".lando.yml", content: "name: after\n" }],
    }),
  );
  const guard = makeManagedFileTransactionGuard({
    journalRoot: () => dataRoot,
    privateFileAccess: ownerOnlyFileAccess,
  });
  // When
  await Effect.runPromise(guard.ensureConsistent(appRoot));
  // Then
  expect(await Bun.file(join(appRoot, ".lando.yml")).text()).toBe("name: after\n");
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});
