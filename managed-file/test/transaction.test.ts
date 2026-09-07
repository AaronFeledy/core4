import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Exit, type Scope } from "effect";

import { ManagedFileTransactionError } from "../src/transaction.ts";
import { fixture as makeFixture } from "./transaction-fixture.ts";

const digestOf = (content: string): string => createHash("sha256").update(content).digest("hex");

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const failure = async <A>(
  effect: Effect.Effect<A, ManagedFileTransactionError, Scope.Scope>,
): Promise<ManagedFileTransactionError> => {
  const exit = await Effect.runPromiseExit(Effect.scoped(effect));
  if (
    Exit.isFailure(exit) &&
    exit.cause._tag === "Fail" &&
    exit.cause.error instanceof ManagedFileTransactionError
  ) {
    return exit.cause.error;
  }
  throw new Error(`expected a ManagedFileTransactionError failure, got ${JSON.stringify(exit)}`);
};

const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

const stageNames = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir)).filter((name) => name.includes(".lando-stage."));

const backupNames = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir)).filter((name) => name.includes(".bak."));

describe("managed-file transaction coordinator", () => {
  test("commits a mixed write set, keeps immutable backups, and clears the journal", async () => {
    // Given an app root with one existing file and one absent target
    const { appRoot, transactions } = await makeFixture();
    await writeFile(join(appRoot, ".lando.yml"), "name: before\n", "utf8");

    // When the caller prepares and commits both outputs
    const receipt = await runScoped(
      transactions.run({
        appRoot,
        operations: [
          { kind: "write", path: ".lando.yml", content: "name: after\n" },
          { kind: "write", path: ".lando.local.yml", content: "name: local\n" },
        ],
      }),
    );

    // Then both targets hold the new bytes
    expect(await readFile(join(appRoot, ".lando.yml"), "utf8")).toBe("name: after\n");
    expect(await readFile(join(appRoot, ".lando.local.yml"), "utf8")).toBe("name: local\n");

    // And the existing input kept a digest-named immutable backup
    const backup = join(appRoot, `.lando.yml.bak.${digestOf("name: before\n")}`);
    expect(await readFile(backup, "utf8")).toBe("name: before\n");
    expect(receipt.backups).toContain(`.lando.yml.bak.${digestOf("name: before\n")}`);

    // And the absent input produced no backup
    expect(await backupNames(appRoot)).toHaveLength(1);

    // And every stage and the journal are gone
    expect(await stageNames(appRoot)).toHaveLength(0);
    expect(await run(transactions.readJournal(appRoot))).toBeNull();
    expect(receipt.written).toEqual([".lando.local.yml", ".lando.yml"]);
  });

  test("rejects a symlinked target before creating any artifact", async () => {
    // Given a target path that is a symlink
    const { appRoot, transactions } = await makeFixture();
    await writeFile(join(appRoot, "real.yml"), "name: real\n", "utf8");
    await symlink(join(appRoot, "real.yml"), join(appRoot, ".lando.yml"));

    // When the caller prepares a write to the symlink
    const error = await failure(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: ".lando.yml", content: "name: after\n" }],
      }),
    );

    // Then it fails on path policy and mutates nothing
    expect(error.reason).toBe("path");
    expect(await readFile(join(appRoot, "real.yml"), "utf8")).toBe("name: real\n");
    expect(await stageNames(appRoot)).toHaveLength(0);
    expect(await backupNames(appRoot)).toHaveLength(0);
    expect(await run(transactions.readJournal(appRoot))).toBeNull();
  });

  test("rejects a target that escapes the canonical app root", async () => {
    // Given an escaping relative path
    const { appRoot, transactions } = await makeFixture();

    // When the caller prepares a write outside the root
    const error = await failure(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: "../escape.yml", content: "name: escape\n" }],
      }),
    );

    // Then it fails on path policy
    expect(error.reason).toBe("path");
    expect(error.path).toBe("../escape.yml");
  });

  test("fails commit without mutating when the target changed after prepare", async () => {
    // Given a prepared transaction over an existing file
    const { appRoot, transactions } = await makeFixture();
    const target = join(appRoot, ".lando.yml");
    await writeFile(target, "name: before\n", "utf8");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* transactions.prepare({
            appRoot,
            operations: [{ kind: "write", path: ".lando.yml", content: "name: after\n" }],
          });

          // When a concurrent editor rewrites the target between prepare and commit
          yield* Effect.promise(() => writeFile(target, "name: concurrent\n", "utf8"));

          return yield* transactions.commit(prepared);
        }),
      ),
    );

    // Then commit fails as a conflict and the concurrent edit survives
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
      expect(exit.cause.error.reason).toBe("conflict");
    }
    expect(await readFile(target, "utf8")).toBe("name: concurrent\n");
  });

  test("leaves a complete owner-only prepared journal when the caller abandons prepare", async () => {
    // Given an abandoned prepare (crash-before-commit boundary)
    const { appRoot, transactions } = await makeFixture();
    await writeFile(join(appRoot, ".lando.yml"), "name: before\n", "utf8");

    const prepared = await runScoped(
      transactions.prepare({
        appRoot,
        operations: [
          { kind: "write", path: ".lando.yml", content: "name: after\n" },
          { kind: "remove", path: "gone.yml" },
        ],
      }),
    );

    // Then the journal records the complete ordered before/after plan
    const journal = await run(transactions.readJournal(appRoot));
    expect(journal?.state).toBe("prepared");
    expect(journal?.id).toBe(prepared.id);
    const entry = journal?.entries.find((item) => item.path === ".lando.yml");
    expect(entry?.before).toEqual({
      present: true,
      digest: digestOf("name: before\n"),
      mode: await modeOf(join(appRoot, ".lando.yml")),
      backup: `.lando.yml.bak.${digestOf("name: before\n")}`,
    });
    expect(entry?.after.present).toBe(true);
    const absent = journal?.entries.find((item) => item.path === "gone.yml");
    expect(absent).toBeUndefined();

    // And the journal is owner-only, the stage survives, and no target was mutated
    expect(await modeOf(prepared.journalPath)).toBe(0o600);
    expect(await stageNames(appRoot)).toHaveLength(1);
    expect(await readFile(join(appRoot, ".lando.yml"), "utf8")).toBe("name: before\n");
  });

  test.skipIf(process.platform === "win32")(
    "applies exact output modes for new, existing, and secret targets",
    async () => {
      // Given an existing nonsecret target with a distinctive mode
      const { appRoot, transactions } = await makeFixture();
      await writeFile(join(appRoot, "existing.yml"), "name: before\n", "utf8");
      await chmod(join(appRoot, "existing.yml"), 0o640);
      await writeFile(join(appRoot, "secret.env"), "OLD=value\n", { mode: 0o640 });

      // When the transaction rewrites it and adds a new plus a secret output
      await runScoped(
        transactions.run({
          appRoot,
          operations: [
            { kind: "write", path: "existing.yml", content: "name: after\n" },
            { kind: "write", path: "new.yml", content: "name: new\n" },
            { kind: "write", path: "secret.env", content: "TOKEN=value\n", secret: true },
          ],
        }),
      );

      // Then the existing mode is preserved, the new file is restrictive, the secret is owner-only
      expect(await modeOf(join(appRoot, "existing.yml"))).toBe(0o640);
      expect(await modeOf(join(appRoot, "new.yml"))).toBe(0o600);
      expect(await modeOf(join(appRoot, "secret.env"))).toBe(0o600);
      expect(await modeOf(join(appRoot, `existing.yml.bak.${digestOf("name: before\n")}`))).toBe(0o600);
    },
  );

  test("reuses a matching immutable backup and fails closed on a corrupted one", async () => {
    // Given a prior transaction that already produced the backup
    const { appRoot, transactions } = await makeFixture();
    await writeFile(join(appRoot, ".lando.yml"), "name: before\n", "utf8");
    const backup = join(appRoot, `.lando.yml.bak.${digestOf("name: before\n")}`);
    await writeFile(backup, "name: before\n", "utf8");
    await chmod(backup, 0o600);
    const backupIdentity = await lstat(backup);

    // When a transaction prepares over the same before-state
    await runScoped(
      transactions.run({
        appRoot,
        operations: [{ kind: "write", path: ".lando.yml", content: "name: after\n" }],
      }),
    );

    // Then the existing backup is reused untouched
    expect(await readFile(backup, "utf8")).toBe("name: before\n");
    expect((await lstat(backup)).ino).toBe(backupIdentity.ino);
    expect(await backupNames(appRoot)).toHaveLength(1);

    // And a backup whose bytes no longer match its digest name fails before mutation
    await writeFile(join(appRoot, ".lando.yml"), "name: before\n", "utf8");
    await writeFile(backup, "tampered\n", "utf8");
    const error = await failure(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: ".lando.yml", content: "name: next\n" }],
      }),
    );
    expect(error.reason).toBe("conflict");
    expect(await readFile(join(appRoot, ".lando.yml"), "utf8")).toBe("name: before\n");
  });

  test("removes a target only after backing it up", async () => {
    // Given an existing file scheduled for removal
    const { appRoot, transactions } = await makeFixture();
    await writeFile(join(appRoot, ".lando.recipe.yml"), "recipe: lamp\n", "utf8");

    // When the transaction commits the removal
    const receipt = await runScoped(
      transactions.run({ appRoot, operations: [{ kind: "remove", path: ".lando.recipe.yml" }] }),
    );

    // Then the target is gone and its immutable backup remains
    expect(receipt.removed).toEqual([".lando.recipe.yml"]);
    const backup = join(appRoot, `.lando.recipe.yml.bak.${digestOf("recipe: lamp\n")}`);
    expect(await readFile(backup, "utf8")).toBe("recipe: lamp\n");
    await expect(readFile(join(appRoot, ".lando.recipe.yml"), "utf8")).rejects.toThrow();
    expect(await run(transactions.readJournal(appRoot))).toBeNull();
  });

  test("keeps raw bytes out of the journal and error payloads", async () => {
    // Given a secret payload and a failing second operation
    const { appRoot, transactions } = await makeFixture();
    const secret = "TOKEN=super-secret-value\n";
    await writeFile(join(appRoot, ".lando.yml"), "name: before\n", "utf8");

    const prepared = await runScoped(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: "secret.env", content: secret, secret: true }],
      }),
    );
    const journalText = await readFile(prepared.journalPath, "utf8");

    // Then the journal carries digests and modes only
    expect(journalText).not.toContain("super-secret-value");
    expect(journalText).toContain(digestOf(secret));

    // And a path failure carries no content either
    const error = await failure(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "write", path: "../escape.env", content: secret, secret: true }],
      }),
    );
    expect(JSON.stringify(error)).not.toContain("super-secret-value");
  });

  test("does not delete unjournaled foreign stages when prepare fails on path policy", async () => {
    // Given a foreign stage left by another transaction
    const { appRoot, transactions } = await makeFixture();
    const foreign = join(appRoot, ".lando.yml.lando-stage.00000000-foreign");
    await writeFile(foreign, "name: foreign\n", "utf8");

    // When prepare rejects the whole path graph before creating artifacts
    const error = await failure(
      transactions.prepare({
        appRoot,
        operations: [
          { kind: "write", path: "ok.yml", content: "name: ok\n" },
          { kind: "write", path: "../escape.yml", content: "name: escape\n" },
        ],
      }),
    );

    // Then it never guesses ownership of the unjournaled foreign stage
    expect(error.reason).toBe("path");
    expect(await readFile(foreign, "utf8")).toBe("name: foreign\n");
    expect(await stageNames(appRoot)).toEqual([".lando.yml.lando-stage.00000000-foreign"]);
    expect(await run(transactions.readJournal(appRoot))).toBeNull();
  });
});
