import { expect, test } from "bun:test";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { digestOf } from "../src/transaction-fs.ts";
import { fixture, scoped } from "./transaction-fixture.ts";

test.each(["prepared", "committing"] as const)(
  "rejects a readonly source changed at %s before any target mutation",
  async (point) => {
    // Given
    let source = "";
    const { appRoot, transactions } = await fixture((checkpoint) =>
      checkpoint === point
        ? Effect.promise(async () => {
            await Bun.write(source, "changed");
          })
        : Effect.void,
    );
    source = join(appRoot, "source");
    await Bun.write(source, "original");
    await Bun.write(join(appRoot, "target"), "before");
    await Bun.write(join(appRoot, "removed"), "keep");
    const before = await stat(join(appRoot, "target"));
    // When
    const result = await scoped(
      Effect.either(
        transactions.run({
          appRoot,
          readConditions: [
            { path: "source", expectedBefore: { present: true, digest: digestOf("original") } },
          ],
          operations: [
            { kind: "write", path: "target", content: "after" },
            { kind: "write", path: "created", content: "new" },
            { kind: "remove", path: "removed" },
          ],
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Left",
      left: { phase: "commit", reason: "conflict", path: "source" },
    });
    expect(await Bun.file(join(appRoot, "target")).text()).toBe("before");
    expect(await stat(join(appRoot, "target"))).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(await Bun.file(join(appRoot, "created")).exists()).toBe(false);
    expect(await Bun.file(join(appRoot, "removed")).text()).toBe("keep");
    expect(await Bun.file(source).text()).toBe("changed");
    const journal = await scoped(transactions.readJournal(appRoot));
    expect(journal?.state).toBe(point === "prepared" ? "prepared" : "committing");
    expect(journal?.entries.map((entry) => entry.path)).toEqual(["target", "created", "removed"]);
    expect(journal).not.toHaveProperty("readConditions");
  },
);

test("rejects a readonly source removed between explicit prepare and commit", async () => {
  // Given
  const { appRoot, transactions } = await fixture();
  const source = join(appRoot, "source");
  await Bun.write(source, "original");
  // When
  const result = await scoped(
    Effect.gen(function* () {
      const prepared = yield* transactions.prepare({
        appRoot,
        readConditions: [{ path: "source", expectedBefore: { present: true, digest: digestOf("original") } }],
        operations: [{ kind: "write", path: "target", content: "translated" }],
      });
      yield* Effect.promise(() => unlink(source));
      return yield* Effect.either(transactions.commit(prepared));
    }),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { phase: "commit", reason: "conflict", path: "source" },
  });
  expect(await Bun.file(join(appRoot, "target")).exists()).toBe(false);
});
