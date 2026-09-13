import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PrivateFileAccess, PrivateFileAccessError } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { createStage, ensureBackup } from "../src/transaction-fs.ts";
import { fixture, scoped } from "./transaction-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const temporary = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-private-access-"));
  roots.push(root);
  return root;
};

test("restricts transaction stages before writing bytes", async () => {
  // Given a stage and an owner-only access observer
  const path = join(await temporary(), "config.lando-stage.test");
  const observed: string[] = [];

  // When the stage is created
  await createStage({
    path,
    bytes: new TextEncoder().encode("secret"),
    record: () => undefined,
    privateFileAccess: {
      enforce: async (created) => {
        observed.push(await readFile(created, "utf8"));
      },
      verify: () => Promise.resolve(),
    },
  });

  // Then access is restricted while the stage is empty
  expect(observed).toEqual([""]);
  expect(await readFile(path, "utf8")).toBe("secret");
});

test("restricts immutable backups before writing bytes", async () => {
  // Given a backup and an owner-only access observer
  const path = join(await temporary(), "config.bak.digest");
  const observed: string[] = [];

  // When the backup is created
  await ensureBackup({
    path,
    bytes: new TextEncoder().encode("secret"),
    privateFileAccess: {
      enforce: async (created) => {
        observed.push(await readFile(created, "utf8"));
      },
      verify: () => Promise.resolve(),
    },
  });

  // Then access is restricted while the backup is empty
  expect(observed).toEqual([""]);
  expect(await readFile(path, "utf8")).toBe("secret");
});

for (const artifact of ["stage", "backup"] as const) {
  test(`rejects a successful ACL swap before writing the ${artifact}`, async () => {
    // Given an ACL hook that secures a replacement instead of the opened inode
    const path = join(await temporary(), artifact);
    const bytes = new TextEncoder().encode("sensitive bytes");
    const privateFileAccess: PrivateFileAccess = {
      enforce: async (created) => {
        await rename(created, `${created}.original`);
        await writeFile(created, "foreign");
      },
      verify: () => Promise.resolve(),
    };
    // When enforcement reports success after swapping the pathname
    const operation =
      artifact === "stage"
        ? createStage({ path, bytes, record: () => undefined, privateFileAccess })
        : ensureBackup({ path, bytes, privateFileAccess });
    // Then neither inode receives sensitive bytes
    await expect(operation).rejects.toMatchObject({ _tag: "ManagedFileTransactionError" });
    expect(await readFile(`${path}.original`, "utf8")).toBe("");
    expect(await readFile(path, "utf8")).toBe("foreign");
  });

  test(`removes an empty ${artifact} when access restriction fails`, async () => {
    // Given an owner-only access operation that fails
    const path = join(await temporary(), artifact);
    const privateFileAccess: PrivateFileAccess = {
      enforce: () => Promise.reject(new Error("injected ACL failure")),
      verify: () => Promise.resolve(),
    };

    // When private artifact initialization applies access restrictions
    const operation =
      artifact === "stage"
        ? createStage({ path, bytes: new Uint8Array(), record: () => undefined, privateFileAccess })
        : ensureBackup({ path, bytes: new Uint8Array(), privateFileAccess });

    // Then initialization fails and removes only its empty artifact
    await expect(operation).rejects.toThrow("injected ACL failure");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test(`preserves a foreign ${artifact} replacement when access restriction fails`, async () => {
    // Given an access hook that replaces the exclusively created artifact
    const path = join(await temporary(), artifact);
    const privateFileAccess: PrivateFileAccess = {
      enforce: async (created) => {
        await rename(created, `${created}.original`);
        await writeFile(created, "foreign");
        throw new Error("injected ACL failure");
      },
      verify: () => Promise.resolve(),
    };

    // When private artifact initialization fails after that replacement
    const operation =
      artifact === "stage"
        ? createStage({ path, bytes: new Uint8Array(), record: () => undefined, privateFileAccess })
        : ensureBackup({ path, bytes: new Uint8Array(), privateFileAccess });

    // Then cleanup leaves the foreign inode untouched
    await expect(operation).rejects.toThrow("injected ACL failure");
    expect(await readFile(path, "utf8")).toBe("foreign");
  });
}

for (const artifact of ["stage", "backup"] as const) {
  test(`blocks recovery when the existing ${artifact} ACL is not owner-only`, async () => {
    // Given a prepared transaction whose ACL verifier later rejects one private artifact
    const rejectedPaths = new Set<string>();
    const privateFileAccess: PrivateFileAccess = {
      enforce: () => Promise.resolve(),
      verify: (path) =>
        rejectedPaths.has(path) ? Promise.reject(new PrivateFileAccessError(path)) : Promise.resolve(),
    };
    const context = await fixture(
      (point) => (point === "prepared" ? Effect.fail("crash") : Effect.void),
      privateFileAccess,
    );
    await writeFile(join(context.appRoot, "config"), "old");
    await scoped(
      Effect.either(
        context.transactions.run({
          appRoot: context.appRoot,
          operations: [{ kind: "write", path: "config", content: "new" }],
        }),
      ),
    );
    const names = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: context.root, absolute: true }));
    const rejectedPath = names.find((path) =>
      artifact === "stage" ? path.includes(".lando-stage.") : path.includes(".bak."),
    );
    if (rejectedPath === undefined) throw new Error(`missing ${artifact}`);
    rejectedPaths.add(rejectedPath);

    // When recovery preflights the persisted transaction
    const outcome = await scoped(Effect.either(context.transactions.recover(context.appRoot)));

    // Then it blocks before publishing the staged bytes
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left.reason).toBe("blocked");
    expect(await readFile(join(context.appRoot, "config"), "utf8")).toBe("old");
  });
}

test("refuses to trust a transaction journal whose ACL is not owner-only", async () => {
  // Given a prepared transaction and a verifier that rejects its journal after creation
  let rejectJournal = false;
  const privateFileAccess: PrivateFileAccess = {
    enforce: () => Promise.resolve(),
    verify: (path) =>
      rejectJournal && path.endsWith("transaction.json")
        ? Promise.reject(new PrivateFileAccessError(path))
        : Promise.resolve(),
  };
  const context = await fixture(
    (point) => (point === "prepared" ? Effect.fail("crash") : Effect.void),
    privateFileAccess,
  );
  await writeFile(join(context.appRoot, "config"), "old");
  await scoped(
    Effect.either(
      context.transactions.run({
        appRoot: context.appRoot,
        operations: [{ kind: "write", path: "config", content: "new" }],
      }),
    ),
  );
  rejectJournal = true;

  // When read-only recovery inspection opens the journal
  const outcome = await scoped(Effect.either(context.transactions.pending(context.appRoot)));

  // Then inspection fails closed before decoding the journal bytes
  expect(outcome._tag).toBe("Left");
  if (outcome._tag === "Left") expect(outcome.left.reason).toBe("journal");
});
