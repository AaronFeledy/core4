import { expect, test } from "bun:test";
import { readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { digestOf } from "../src/transaction-fs.ts";
import { fixture, scoped } from "./transaction-fixture.ts";

test("rejects stale readonly sources before producing artifacts", async () => {
  // Given
  const { appRoot, transactions } = await fixture();
  await Bun.write(join(appRoot, "source"), "changed");
  const request = {
    appRoot,
    readConditions: [{ path: "source", expectedBefore: { present: true as const, digest: digestOf("old") } }],
    operations: [{ kind: "write" as const, path: "target", content: "translated" }],
  };
  // When
  const result = await scoped(Effect.either(transactions.run(request)));
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { reason: "conflict", phase: "prepare", path: "source" },
  });
  expect(await readdir(appRoot)).toEqual(["source"]);
});

test("does not rewrite or back up readonly sources", async () => {
  // Given
  const { appRoot, transactions } = await fixture();
  const source = join(appRoot, "source");
  await Bun.write(source, "original");
  const before = await stat(source);
  // When
  const receipt = await scoped(
    transactions.run({
      appRoot,
      readConditions: [{ path: "source", expectedBefore: { present: true, digest: digestOf("original") } }],
      operations: [{ kind: "write", path: "target", content: "translated" }],
    }),
  );
  // Then
  expect(receipt.written).toEqual(["target"]);
  expect(receipt.backups).toEqual([]);
  expect(await stat(source)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs, mode: before.mode });
  expect((await readdir(appRoot)).sort()).toEqual(["source", "target"]);
});

test("rejects a present source when absence was required", async () => {
  // Given
  const { appRoot, transactions } = await fixture();
  await Bun.write(join(appRoot, "source"), "new");
  // When
  const result = await scoped(
    Effect.either(
      transactions.run({
        appRoot,
        readConditions: [{ path: "source", expectedBefore: { present: false } }],
        operations: [],
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "conflict" } });
});

test("rejects symlinked readonly sources", async () => {
  // Given
  const { appRoot, transactions } = await fixture();
  await Bun.write(join(appRoot, "real"), "original");
  await symlink("real", join(appRoot, "source"));
  // When
  const result = await scoped(
    Effect.either(
      transactions.run({
        appRoot,
        readConditions: [{ path: "source", expectedBefore: { present: true, digest: digestOf("original") } }],
        operations: [{ kind: "write", path: "target", content: "translated" }],
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "path" } });
  expect(await Bun.file(join(appRoot, "target")).exists()).toBe(false);
});
