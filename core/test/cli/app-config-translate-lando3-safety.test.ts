import { expect, test } from "bun:test";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { makeManagedFileTransactionGuard } from "@lando/managed-file/transaction";
import { Effect } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { failure, originals, snapshot, withFixture } from "./translate-lando3-fixture.ts";

test.each(["edit", "delete"] as const)(
  "preserves source state when a concurrent %s happens before prepare",
  (change) =>
    withFixture(async ({ root, run, translators }) => {
      // Given
      let changed = false;
      const path = join(root, ".lando.local.yml");
      const edited = `${originals[".lando.local.yml"]}# concurrent edit\n`;
      const racing = translators.map((translator) => ({
        ...translator,
        translate: (input: Parameters<typeof translator.translate>[0]) =>
          translator.translate(input).pipe(
            Effect.tap(() =>
              Effect.promise(async () => {
                if (changed) return;
                changed = true;
                if (change === "edit") await Bun.write(path, edited);
                else await unlink(path);
              }),
            ),
          ),
      }));
      // When
      const result = await failure(run({ write: true, translators: racing }));
      // Then
      expect(changed).toBe(true);
      expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigTranslateError" } });
      const expected: Record<string, string> = { ...originals };
      if (change === "edit") expected[".lando.local.yml"] = edited;
      else Reflect.deleteProperty(expected, ".lando.local.yml");
      expect(await snapshot(root)).toEqual(expected);
      expect(
        (await readdir(root)).filter((name) => name.includes(".bak.") || name.includes(".lando-stage.")),
      ).toEqual([]);
    }),
);

test("single-layer conversion refuses legacy context before staging", () =>
  withFixture(async ({ root, run }) => {
    // Given / When
    const result = await failure(run({ write: true, files: [".lando.local.yml"] }));
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigTranslateError" } });
    if (result._tag === "Left" && result.left._tag === "ConfigTranslateError")
      expect(result.left.remediation).toContain("full conversion");
    expect(await snapshot(root)).toEqual(originals);
    expect((await readdir(root)).sort()).toEqual(Object.keys(originals).sort());
  }));

test("guard blocks manual resolution when a prepared source is edited", () =>
  withFixture(async ({ root, run, journalRoot }) => {
    // Given
    const edited = `${originals[".lando.local.yml"]}# concurrent edit\n`;
    const result = await failure(
      run({
        write: true,
        transactionCheckpoint: (point) =>
          point === "prepared"
            ? Effect.promise(async () => {
                await Bun.write(join(root, ".lando.local.yml"), edited);
              })
            : Effect.void,
      }),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigTranslateError" } });
    // When
    const recovery = await failure(
      makeManagedFileTransactionGuard({
        journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
      }).ensureConsistent(root),
    );
    // Then
    expect(recovery).toMatchObject({
      _tag: "Left",
      left: { _tag: "ManagedFileTransactionError", reason: "blocked" },
    });
    expect(await snapshot(root)).toEqual({ ...originals, ".lando.local.yml": edited });
  }));

test("identical inputs produce byte-identical previews, writes, and diagnostics", async () => {
  // Given
  const copies: unknown[] = [];
  for (let index = 0; index < 2; index++)
    await withFixture(async ({ root, run }) => {
      const first = await Effect.runPromise(run());
      // When
      const second = await Effect.runPromise(run());
      const written = await Effect.runPromise(run({ write: true }));
      // Then
      expect(second).toEqual(first);
      if (written.mode !== "write") throw new Error("expected write");
      copies.push({ files: await snapshot(root), diagnostics: written.diagnostics });
    });
  expect(copies[1]).toEqual(copies[0]);
});
