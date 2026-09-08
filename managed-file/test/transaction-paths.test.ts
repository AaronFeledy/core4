import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

test("validates target and artifact collisions before producing artifacts", async () => {
  // Given an existing target and a second target named after its backup
  const { appRoot, transactions } = await fixture();
  const digest = createHash("sha256").update("old").digest("hex");
  await writeFile(join(appRoot, "a"), "old");
  // When the complete path graph is prepared
  const result = await scoped(
    Effect.either(
      transactions.prepare({
        appRoot,
        operations: [
          { kind: "write", path: "a", content: "new" },
          { kind: "write", path: `a.bak.${digest}`, content: "collision" },
        ],
      }),
    ),
  );
  // Then no backup or stage has been produced
  expect(result._tag).toBe("Left");
  expect(await readdir(appRoot)).toEqual(["a"]);
});

test("rejects a symlinked later backup before creating an earlier backup", async () => {
  // Given a valid first target and a symlink at the second backup path
  const { appRoot, transactions } = await fixture();
  const digest = createHash("sha256").update("old").digest("hex");
  await writeFile(join(appRoot, "a"), "old");
  await writeFile(join(appRoot, "b"), "old");
  await symlink(join(appRoot, "b"), join(appRoot, `b.bak.${digest}`));
  const before = await readdir(appRoot);
  // When the complete artifact graph is validated
  await scoped(
    Effect.either(
      transactions.prepare({
        appRoot,
        operations: [
          { kind: "write", path: "a", content: "new" },
          { kind: "write", path: "b", content: "new" },
        ],
      }),
    ),
  );
  // Then no artifact from the earlier operation exists
  expect(await readdir(appRoot)).toEqual(before);
});

for (const kind of ["alias", "parent-symlink", "directory", "hardlink"] as const) {
  test(`rejects ${kind} targets without artifacts`, async () => {
    // Given an invalid complete path graph
    const { appRoot, transactions } = await fixture();
    await writeFile(join(appRoot, "a"), "old");
    await mkdir(join(appRoot, "dir"));
    await symlink(join(appRoot, "dir"), join(appRoot, "alias"));
    if (kind === "hardlink") await link(join(appRoot, "a"), join(appRoot, "linked"));
    const path =
      kind === "alias"
        ? "./a"
        : kind === "parent-symlink"
          ? "alias/new"
          : kind === "directory"
            ? "dir"
            : "linked";
    const before = await readdir(appRoot);
    // When the invalid target follows an otherwise valid operation
    const result = await scoped(
      Effect.either(
        transactions.prepare({
          appRoot,
          operations: [
            { kind: "write", path: "a", content: "new" },
            { kind: "write", path, content: "other" },
          ],
        }),
      ),
    );
    // Then the whole graph is rejected without artifacts
    expect(result._tag).toBe("Left");
    expect(await readdir(appRoot)).toEqual(before);
  });
}

for (const kind of ["symlink", "hardlink", "permissions", "corrupt"] as const) {
  test(`rejects a ${kind} immutable backup`, async () => {
    // Given an artifact that cannot be trusted as an immutable private backup
    const { appRoot, transactions } = await fixture();
    const digest = createHash("sha256").update("old").digest("hex");
    const backup = join(appRoot, `a.bak.${digest}`);
    await writeFile(join(appRoot, "a"), "old");
    await writeFile(join(appRoot, "foreign"), "old", { mode: 0o600 });
    switch (kind) {
      case "symlink":
        await symlink(join(appRoot, "foreign"), backup);
        break;
      case "hardlink":
        await link(join(appRoot, "foreign"), backup);
        break;
      case "permissions":
        await writeFile(backup, "old");
        await chmod(backup, 0o644);
        break;
      case "corrupt":
        await writeFile(backup, "corrupt", { mode: 0o600 });
        break;
    }
    // When prepare tries to reuse the backup
    const result = await scoped(
      Effect.either(
        transactions.prepare({ appRoot, operations: [{ kind: "write", path: "a", content: "new" }] }),
      ),
    );
    // Then no target mutation or stage is allowed
    if (kind !== "permissions" || process.platform !== "win32") expect(result._tag).toBe("Left");
    expect(await readFile(join(appRoot, "a"), "utf8")).toBe("old");
  });
}

test("hashes and preserves arbitrary bytes without UTF-8 conversion", async () => {
  // Given non-UTF8 before and after bytes
  const { appRoot, transactions } = await fixture();
  const before = new Uint8Array([0xff, 0xfe, 0, 0x80]);
  const after = new Uint8Array([0xff, 0xfe, 1, 0x81]);
  await writeFile(join(appRoot, "binary"), before);
  // When the binary write is committed
  const result = await scoped(
    transactions.run({ appRoot, operations: [{ kind: "write", path: "binary", content: after }] }),
  );
  // Then both published bytes and digest-addressed backup are exact
  expect(new Uint8Array(await readFile(join(appRoot, "binary")))).toEqual(after);
  expect(result.backups).toEqual([`binary.bak.${createHash("sha256").update(before).digest("hex")}`]);
  expect(new Uint8Array(await readFile(join(appRoot, result.backups[0] ?? "missing")))).toEqual(before);
});

test("normalizes exact no-op writes and absent removals", async () => {
  // Given unchanged bytes and mode plus an absent removal
  const { appRoot, transactions } = await fixture();
  await writeFile(join(appRoot, "a"), "same");
  // When the transaction is prepared
  await scoped(
    transactions.prepare({
      appRoot,
      operations: [
        { kind: "write", path: "a", content: "same" },
        { kind: "remove", path: "absent" },
      ],
    }),
  );
  // Then the durable plan contains no ambiguous equal tuples or artifacts
  expect((await scoped(transactions.readJournal(appRoot)))?.entries).toEqual([]);
  expect(await readdir(appRoot)).toEqual(["a"]);
});
