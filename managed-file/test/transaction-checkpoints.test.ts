import { expect, test } from "bun:test";
import { lstat, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Fiber } from "effect";
import type { TransactionCheckpoint } from "../src/transaction.ts";
import { fixture, scoped } from "./transaction-fixture.ts";

for (const point of [
  "prepared",
  "committing",
  "after-mutation",
  "committed",
] satisfies TransactionCheckpoint[]) {
  test(`retains recoverable state when interrupted at ${point}`, async () => {
    // Given a deterministic interruption at a durable boundary
    const { appRoot, transactions } = await fixture((at) =>
      at === point ? Effect.fail("private failure") : Effect.void,
    );
    await writeFile(join(appRoot, "a"), "old-a");
    await writeFile(join(appRoot, "b"), "old-b");
    // When the ordered transaction reaches that boundary
    const result = await scoped(
      Effect.either(
        transactions.run({
          appRoot,
          operations: [
            { kind: "write", path: "a", content: "new-a" },
            { kind: "write", path: "b", content: "new-b" },
          ],
        }),
      ),
    );
    // Then the full plan survives with the corresponding partial disk state
    expect(result._tag).toBe("Left");
    const journal = await scoped(transactions.readJournal(appRoot));
    expect(journal?.state).toBe(point === "after-mutation" ? "committing" : point);
    expect(journal?.entries).toHaveLength(2);
    expect(await readFile(join(appRoot, "a"), "utf8")).toBe(
      point === "committed" || point === "after-mutation" ? "new-a" : "old-a",
    );
    expect(await readFile(join(appRoot, "b"), "utf8")).toBe(point === "committed" ? "new-b" : "old-b");
    const retry = await scoped(Effect.either(transactions.prepare({ appRoot, operations: [] })));
    expect(retry._tag).toBe("Left");
  });
}

test("cleans identity-owned stages when creation checkpoint fails", async () => {
  // Given a foreign artifact beside a transaction's stage
  const { appRoot, transactions } = await fixture((at) =>
    at === "stage-created" ? Effect.fail("stop") : Effect.void,
  );
  const foreign = "a.lando-stage.foreign";
  await writeFile(join(appRoot, foreign), "foreign");
  // When prepare fails after its first exclusive stage
  await scoped(
    Effect.either(
      transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "secret" }] }),
    ),
  );
  // Then only the foreign stage remains and no journal is durable
  expect(await readdir(appRoot)).toEqual([foreign]);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});

test("preserves a replacement inode during pre-prepared cleanup", async () => {
  // Given a stage replaced by an unrelated writer before prepare fails
  const { appRoot, transactions } = await fixture((at) =>
    at === "stage-created"
      ? Effect.promise(async () => {
          const names = await readdir(appRoot);
          const stage = names.find((name) => name.includes(".lando-stage."));
          if (stage === undefined) throw new Error("missing stage");
          await rename(join(appRoot, stage), join(appRoot, "saved"));
          await writeFile(join(appRoot, stage), "foreign");
        }).pipe(Effect.zipRight(Effect.fail("stop")))
      : Effect.void,
  );
  // When the registered finalizer runs
  await scoped(
    Effect.either(
      transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "ours" }] }),
    ),
  );
  // Then it never deletes the replacement inode
  const stage = (await readdir(appRoot)).find((name) => name.includes(".lando-stage."));
  expect(stage).toBeDefined();
  expect(await readFile(join(appRoot, stage ?? "missing"), "utf8")).toBe("foreign");
});

test("rechecks each target after the global before-state check", async () => {
  // Given a later target edited after the first mutation
  const { appRoot, transactions } = await fixture((at, index) =>
    at === "after-mutation" && index === 0
      ? Effect.promise(() => writeFile(join(appRoot, "b"), "concurrent"))
      : Effect.void,
  );
  await writeFile(join(appRoot, "b"), "old");
  // When the second entry reaches its immediate recheck
  const result = await scoped(
    Effect.either(
      transactions.run({
        appRoot,
        operations: [
          { kind: "write", path: "a", content: "new" },
          { kind: "write", path: "b", content: "new" },
        ],
      }),
    ),
  );
  // Then the concurrent edit survives and the journal stays committing
  expect(result._tag).toBe("Left");
  expect(await readFile(join(appRoot, "b"), "utf8")).toBe("concurrent");
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("committing");
});

test("holds one canonical-root lock and releases it on interruption", async () => {
  // Given two spellings of the same root and a retained prepare scope
  const { root, appRoot, transactions } = await fixture();
  const alias = join(root, "alias");
  await symlink(appRoot, alias);
  const ready = await Effect.runPromise(Effect.makeLatch());
  const fiber = Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        yield* transactions.prepare({ appRoot, operations: [] });
        yield* ready.open;
        yield* Effect.never;
      }),
    ),
  );
  await Effect.runPromise(ready.await);
  const journal = await scoped(transactions.readJournal(alias));
  // When the alias contends, then the original scope is interrupted
  const contention = await scoped(Effect.either(transactions.prepare({ appRoot: alias, operations: [] })));
  await Effect.runPromise(Fiber.interrupt(fiber));
  // Then contention was lock-bounded and interruption released that exact lock
  expect(contention._tag).toBe("Left");
  if (contention._tag === "Left") expect(contention.left.reason).toBe("lock");
  expect(journal?.root).toBe(appRoot);
  const retry = await scoped(Effect.either(transactions.prepare({ appRoot, operations: [] })));
  if (retry._tag === "Left") expect(retry.left.reason).toBe("journal");
});

test("keeps stages physically owner-only before publication", async () => {
  // Given a nonsecret output with group-readable final mode
  const { appRoot, transactions } = await fixture();
  const target = join(appRoot, "a");
  await writeFile(target, "old", { mode: 0o640 });
  // When preparation is abandoned
  const prepared = await scoped(
    transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "new" }] }),
  );
  const journal = await scoped(transactions.readJournal(appRoot));
  // Then the stage and journal are private while the final mode is recorded separately
  const stage = journal?.entries[0]?.stage;
  expect(stage).toBeDefined();
  if (process.platform !== "win32") {
    expect((await lstat(stage?.path ?? "missing")).mode & 0o777).toBe(0o600);
    expect((await lstat(prepared.journalPath)).mode & 0o777).toBe(0o600);
  }
  await expect(lstat(join(dirname(prepared.journalPath), "transaction.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("never overwrites a stage planted after path validation", async () => {
  // Given a concurrent actor planting the second stage after the first is created
  const { appRoot, transactions } = await fixture((at, index) =>
    at === "stage-created" && index === 0
      ? Effect.promise(async () => {
          const first = (await readdir(appRoot)).find((name) => name.startsWith("a.lando-stage."));
          if (first === undefined) throw new Error("missing stage");
          await writeFile(join(appRoot, first.replace(/^a/u, "b")), "foreign");
        })
      : Effect.void,
  );
  // When exclusive creation encounters that foreign stage
  const result = await scoped(
    Effect.either(
      transactions.prepare({
        appRoot,
        operations: [
          { kind: "write", path: "a", content: "ours-a" },
          { kind: "write", path: "b", content: "ours-b" },
        ],
      }),
    ),
  );
  // Then it fails without replacing or cleaning the foreign inode
  expect(result._tag).toBe("Left");
  const names = await readdir(appRoot);
  expect(names).toHaveLength(1);
  expect(await readFile(join(appRoot, names[0] ?? "missing"), "utf8")).toBe("foreign");
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});
