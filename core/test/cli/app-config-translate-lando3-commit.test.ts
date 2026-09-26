import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import { lintLandofile } from "@lando/landofile/lint";
import { parseLandofile } from "@lando/landofile/parser";
import {
  type TransactionCheckpoint,
  makeManagedFileTransactionGuard,
  makeManagedFileTransactions,
} from "@lando/managed-file/transaction";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { failure, originals, snapshot, withFixture } from "./translate-lando3-fixture.ts";

test("full write folds recipe content and backs up every overwritten or removed source", () =>
  withFixture(async ({ root, run }) => {
    // Given / When
    const result = await Effect.runPromise(run({ write: true }));
    // Then
    expect(result.mode).toBe("write");
    if (result.mode !== "write") throw new Error("expected write");
    expect(result.removed).toEqual([join(root, ".lando.recipe.yml")]);
    expect(result.written.map((path) => basename(path)).sort()).toEqual([
      ".lando.dist.yml",
      ".lando.local.yml",
      ".lando.yml",
    ]);
    for (const [name, bytes] of Object.entries(originals)) {
      const backup = join(root, `${name}.bak.${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`);
      expect(result.backups).toContain(backup);
      expect(await Bun.file(backup).text()).toBe(bytes);
    }
    const files = await snapshot(root);
    expect(files).not.toHaveProperty(".lando.recipe.yml");
    for (const [file, content] of Object.entries(files))
      await Effect.runPromise(
        parseLandofile({ file, content, cwd: root }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknown(LandofileAuthoringFragment)(value, { onExcessProperty: "error" }),
          ),
        ),
      );
    expect(Bun.YAML.parse(files[".lando.dist.yml"] ?? "")).toMatchObject({
      services: { cache: { type: "redis:7" } },
    });
    expect(await Effect.runPromise(lintLandofile({ cwd: root }))).toMatchObject({ valid: true });
  }));

const boundaries: readonly (readonly [TransactionCheckpoint, number])[] = [
  ["stage-created", 0],
  ["stage-created", 1],
  ["stage-created", 2],
  ["prepared", -1],
  ["committing", -1],
  ["after-mutation", 0],
  ["after-mutation", 1],
  ["after-mutation", 2],
  ["after-mutation", 3],
  ["committed", -1],
];
test.each(boundaries)("recovers the entire set after %s/%i", (point, index) =>
  withFixture(async ({ root, run, journalRoot }) => {
    // Given
    const preview = await Effect.runPromise(run());
    if (preview.mode !== "preview") throw new Error("expected preview");
    const converted = Object.fromEntries(
      preview.targets.map((target) => [basename(target.path), target.content]),
    );
    // When
    const result = await failure(
      run({
        write: true,
        transactionCheckpoint: (at, i) =>
          at === point && i === index ? Effect.fail("interrupted") : Effect.void,
      }),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigTranslateError" } });
    await Effect.runPromise(
      makeManagedFileTransactionGuard({
        journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
      }).ensureConsistent(root),
    );
    expect(await snapshot(root)).toEqual(point === "stage-created" ? originals : converted);
  }),
);

test.each([
  ["recovering", -1],
  ["after-recovery-mutation", 0],
  ["after-recovery-mutation", 1],
  ["after-recovery-mutation", 2],
  ["after-recovery-mutation", 3],
  ["recovered", -1],
] as const)("resumes interrupted recovery at %s/%i", (point, index) =>
  withFixture(async ({ root, run, journalRoot }) => {
    // Given
    const preview = await Effect.runPromise(run());
    if (preview.mode !== "preview") throw new Error("expected preview");
    expect(
      await failure(
        run({
          write: true,
          transactionCheckpoint: (at) => (at === "prepared" ? Effect.fail("interrupted") : Effect.void),
        }),
      ),
    ).toMatchObject({ _tag: "Left" });
    // When
    const recovery = makeManagedFileTransactions({
      journalRoot,
      privateFileAccess: ownerOnlyFileAccess,
      checkpoint: (at, i) => (at === point && i === index ? Effect.fail("interrupted") : Effect.void),
    });
    const result = await failure(recovery.ensureConsistent(root));
    // Then
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ManagedFileTransactionError" } });
    await Effect.runPromise(
      makeManagedFileTransactionGuard({
        journalRoot,
        privateFileAccess: ownerOnlyFileAccess,
      }).ensureConsistent(root),
    );
    expect(await snapshot(root)).toEqual(
      Object.fromEntries(preview.targets.map((target) => [basename(target.path), target.content])),
    );
  }),
);
