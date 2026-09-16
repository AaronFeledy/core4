import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { Effect, Schema } from "effect";
import { Journal, journalDirectory, openJournal } from "../src/transaction-journal.ts";
import { fixture, ownerOnlyFileAccess, scoped } from "./transaction-fixture.ts";

test("derives its journal from the full canonical-root digest and existing paths primitive", async () => {
  // Given an isolated app and user-data root
  const { appRoot, dataRoot, transactions } = await fixture();
  const appId = `${basename(appRoot)}-${createHash("sha256").update(appRoot).digest("hex")}`;
  // When preparation persists a journal
  const prepared = await scoped(transactions.prepare({ appRoot, operations: [] }));
  // Then no truncated root identity or new paths field is involved
  expect(prepared.journalPath).toBe(
    join(dirname(makeLandoPaths({ userDataRoot: dataRoot }).managedFileLedger(appId)), "transaction.json"),
  );
});

for (const variant of ["root", "corrupt", "version"] as const) {
  test(`fails closed on a journal with invalid ${variant} without exposing its bytes`, async () => {
    // Given a journal that has been corrupted or associated with another root
    const { appRoot, transactions } = await fixture();
    const prepared = await scoped(transactions.prepare({ appRoot, operations: [] }));
    const journal = await scoped(transactions.readJournal(appRoot));
    const marker = "UNTRUSTED-SECRET-PAYLOAD";
    const bytes =
      variant === "corrupt"
        ? marker
        : JSON.stringify({ version: variant === "version" ? 99 : 1, data: { ...journal, root: marker } });
    await writeFile(prepared.journalPath, bytes);
    // When a new transaction attempts preparation
    const result = await scoped(
      Effect.either(
        transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "output" }] }),
      ),
    );
    // Then no target artifacts exist and the error contains no journal data
    expect(result._tag).toBe("Left");
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(await readdir(appRoot)).toEqual([]);
    expect(await readFile(prepared.journalPath, "utf8")).toBe(bytes);
  });
}

test("rejects commit after the preparing scope has released its lock", async () => {
  // Given a prepared handle whose lock scope is closed
  const { appRoot, transactions } = await fixture();
  const prepared = await scoped(
    transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "new" }] }),
  );
  // When that abandoned handle is committed without a lease
  const result = await scoped(Effect.either(transactions.commit(prepared)));
  // Then no target is published and recovery artifacts remain
  expect(result._tag).toBe("Left");
  await expect(lstat(join(appRoot, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("prepared");
});

test("globally revalidates later modes before mutating the first target", async () => {
  // Given a prepared ordered plan with a later existing target
  const { appRoot, transactions } = await fixture();
  await writeFile(join(appRoot, "b"), "old", { mode: 0o600 });
  // When its mode changes before commit
  const result = await scoped(
    Effect.either(
      Effect.gen(function* () {
        const prepared = yield* transactions.prepare({
          appRoot,
          operations: [
            { kind: "write", path: "a", content: "new" },
            { kind: "write", path: "b", content: "new" },
          ],
        });
        yield* Effect.promise(() => chmod(join(appRoot, "b"), 0o400));
        return yield* transactions.commit(prepared);
      }),
    ),
  );
  // Then the first target is untouched and the journal never advances
  expect(result._tag).toBe("Left");
  await expect(lstat(join(appRoot, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("prepared");
});

test("rejects journal fields outside the metadata contract", () => {
  // Given raw content smuggled into otherwise valid journal metadata
  const input = { id: "id", root: "/app", state: "prepared", entries: [], content: "secret" };
  // When the persistence boundary parses the journal
  const decoded = Schema.decodeUnknownEither(Journal, { onExcessProperty: "error" })(input);
  // Then raw content is outside the journal contract
  expect(decoded._tag).toBe("Left");
});

test("retains durable stages even if the prepared journal disappears externally", async () => {
  // Given a durable prepared plan whose journal is removed by an outside actor
  const { appRoot, transactions } = await fixture();
  // When the preparing scope closes after that outside deletion
  await scoped(
    Effect.gen(function* () {
      const prepared = yield* transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: "a", content: "new" }],
      });
      yield* Effect.promise(() => unlink(prepared.journalPath));
    }),
  );
  // Then scope cleanup does not delete already-retained recovery evidence
  expect((await readdir(appRoot)).filter((name) => name.includes(".lando-stage."))).toHaveLength(1);
});

test("refuses to skip the committing journal transition", async () => {
  // Given a durable prepared journal
  const { appRoot, dataRoot, transactions } = await fixture();
  await scoped(transactions.prepare({ appRoot, operations: [] }));
  const store = await scoped(
    openJournal(appRoot, journalDirectory(appRoot, dataRoot), { privateFileAccess: ownerOnlyFileAccess }),
  );
  const journal = await scoped(store.read);
  if (journal === null) throw new Error("missing journal");
  // When the persistence layer is asked to jump directly to committed
  const result = await scoped(Effect.either(store.write({ ...journal, state: "committed" })));
  // Then it refuses the invalid transition and preserves the prepared plan
  expect(result._tag).toBe("Left");
  expect((await scoped(store.read))?.state).toBe("prepared");
});

test("refuses journal removal before committed", async () => {
  // Given a durable prepared journal
  const { appRoot, dataRoot, transactions } = await fixture();
  await scoped(transactions.prepare({ appRoot, operations: [] }));
  const store = await scoped(
    openJournal(appRoot, journalDirectory(appRoot, dataRoot), { privateFileAccess: ownerOnlyFileAccess }),
  );
  // When cleanup is attempted prematurely
  const result = await scoped(Effect.either(store.removeCommitted));
  // Then the recovery plan is preserved
  expect(result._tag).toBe("Left");
  expect((await scoped(store.read))?.state).toBe("prepared");
});
