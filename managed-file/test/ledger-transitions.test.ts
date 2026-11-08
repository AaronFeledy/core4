import { expect, test } from "bun:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ManagedFile, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { type LedgerEntry, planLedgerWrite } from "../src/ledger.ts";
import { makeDiskBackend, makeManagedFileService } from "../src/service.ts";
import { makeTestManagedFileStore } from "../src/testing.ts";
import { fixture, ownerOnlyFileAccess } from "./transaction-fixture.ts";

const adopted: LedgerEntry = {
  id: "test:ledger",
  owner: "test",
  path: "owned.txt",
  mode: "file",
  format: "text",
  marker: "test:ledger",
  lastWrittenChecksum: "before",
  sourceHash: "source",
  state: "adopted",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("ledger refuses removal of adopted ownership", () => {
  const result = Effect.runSync(Effect.result(planLedgerWrite({ operation: "remove" }, adopted)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ManagedFileError", reason: "conflict", operation: "remove" },
  });
});

for (const operation of ["manage", "detect-adoption"] as const) {
  test(`${operation} preserves adopted metadata on replay`, () => {
    const { state: _state, ...body } = adopted;
    const next = Effect.runSync(
      planLedgerWrite(
        { operation, body: { ...body, sourceHash: "replacement", updatedAt: "later" } },
        adopted,
      ),
    );
    expect(next).toBe(adopted);
  });
}

for (const operation of ["adopt", "release"] as const) {
  test(`${operation} preserves an adopted entry on replay and leaves absence unchanged`, () => {
    expect(Effect.runSync(planLedgerWrite({ operation, updatedAt: "later" }, adopted))).toBe(adopted);
    expect(Effect.runSync(planLedgerWrite({ operation, updatedAt: "later" }, undefined))).toBeUndefined();
  });
}

test("removal of an absent ledger entry is settled", () => {
  expect(Effect.runSync(planLedgerWrite({ operation: "remove" }, undefined))).toBeUndefined();
});

for (const mode of ["file", "block"] as const) {
  test(`${mode} ownership stays adopted through forced apply and remove`, async () => {
    const store = await Effect.runPromise(makeTestManagedFileStore());
    const file: ManagedFile = {
      id: "test:sticky",
      owner: "test",
      path: PortablePath.make("sticky.txt"),
      mode,
      format: "text",
      content: { kind: "text", value: "original\n" },
    };
    await Effect.runPromise(Effect.scoped(store.service.apply([file])));
    await Effect.runPromise(store.service.release(file.path));
    const entries = store.ledger();
    const bytes = store.read(file.path);

    const result = await Effect.runPromise(
      Effect.scoped(
        store.service.apply([{ ...file, content: { kind: "text", value: "replacement\n" } }], {
          force: true,
        }),
      ),
    );
    await Effect.runPromise(store.service.remove({ id: file.id }));

    expect(result.entries.map((item) => item.action)).toEqual(["skip-adopted"]);
    expect(store.ledger()).toEqual(entries);
    expect(store.read(file.path)).toBe(bytes);
  });
}

test("settled ledger operations leave the ledger file untouched", async () => {
  const { appRoot, dataRoot } = await fixture();
  const service = await Effect.runPromise(
    makeDiskBackend({
      defaultBase: () => appRoot,
      ledgerRoot: () => dataRoot,
      privateFileAccess: ownerOnlyFileAccess,
    }).pipe(Effect.flatMap(makeManagedFileService)),
  );
  const file: ManagedFile = {
    id: "test:settled",
    owner: "test",
    path: PortablePath.make("settled.txt"),
    mode: "file",
    format: "text",
    content: { kind: "text", value: "original\n" },
  };
  const ledgerDirectory = join(dataRoot, "managed-files");

  await Effect.runPromise(service.remove({ id: file.id }));
  const [appDirectory] = await readdir(ledgerDirectory);
  const ledgerPath = join(ledgerDirectory, appDirectory ?? "", "ledger.json");
  await expect(lstat(ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });

  await Effect.runPromise(Effect.scoped(service.apply([file])));
  await Effect.runPromise(service.release(file.path));
  const before = await lstat(ledgerPath, { bigint: true });
  const bytes = await readFile(ledgerPath, "utf8");

  await Effect.runPromise(service.release(file.path));
  await Effect.runPromise(service.adopt(file.path));
  await Effect.runPromise(service.remove({ id: file.id }));
  await Effect.runPromise(Effect.scoped(service.apply([file])));

  const after = await lstat(ledgerPath, { bigint: true });
  expect({ ino: after.ino, mtime: after.mtimeNs }).toEqual({ ino: before.ino, mtime: before.mtimeNs });
  expect(await readFile(ledgerPath, "utf8")).toBe(bytes);
});
