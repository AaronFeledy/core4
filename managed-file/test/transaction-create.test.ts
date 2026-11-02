import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { HARDLINK_PUBLICATION_REMEDIATION } from "../src/transaction-error.ts";
import { Journal } from "../src/transaction-journal.ts";
import { fixture, scoped } from "./transaction-fixture.ts";

const digestOf = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

const expectMode = async (path: string, mode: number): Promise<void> => {
  const actual = await modeOf(path);
  if (process.platform === "win32") {
    expect((actual & 0o200) !== 0).toBe((mode & 0o200) !== 0);
    return;
  }
  expect(actual).toBe(mode);
};

test("publishes an absent file at 0644 and records only path, digest, and mode", async () => {
  // Given an empty app root and a distinctive payload
  const marker = "CREATE-MARKER-BYTES";
  const { appRoot, transactions } = await fixture();
  let journalText = "";
  let stageMode = 0;

  // When the create commits
  const receipt = await scoped(
    Effect.gen(function* () {
      const prepared = yield* transactions.prepare({
        appRoot,
        operations: [{ kind: "create", path: "index.html", content: marker }],
      });
      yield* Effect.promise(async () => {
        journalText = await readFile(prepared.journalPath, "utf8");
        const stage = (await readdir(appRoot)).find((name) => name.includes(".lando-stage."));
        if (stage === undefined) throw new Error("missing stage");
        stageMode = await modeOf(join(appRoot, stage));
      });
      return yield* transactions.commit(prepared);
    }),
  );

  // Then the public mode is the default, the receipt has no bytes, and the stage was owner-only
  expect(await readFile(join(appRoot, "index.html"), "utf8")).toBe(marker);
  await expectMode(join(appRoot, "index.html"), 0o644);
  expect(receipt.created).toEqual([{ path: "index.html", digest: digestOf(marker), mode: 0o644 }]);
  expect(receipt.written).toEqual(["index.html"]);
  expect(receipt.backups).toEqual([]);
  expect(JSON.stringify(receipt)).not.toContain(marker);
  expect(journalText).not.toContain(marker);
  expect(journalText).toContain(digestOf(marker));
  expect(JSON.parse(journalText).version).toBe(2);
  if (process.platform !== "win32") expect(stageMode).toBe(0o600);
  expect((await readdir(appRoot)).filter((name) => name.includes(".lando-stage."))).toHaveLength(0);
  expect(await scoped(transactions.readJournal(appRoot))).toBeNull();
});

test("applies an explicit safe mode without changing a new write's 0600 default", async () => {
  // Given one create with a non-default safe mode and one new write
  const { appRoot, transactions } = await fixture();

  // When both commit together
  await scoped(
    transactions.run({
      appRoot,
      operations: [
        { kind: "create", path: "tool", content: "#!/bin/sh\n", mode: 0o755 },
        { kind: "write", path: "new.yml", content: "name: new\n" },
      ],
    }),
  );

  // Then only the create uses the requested public mode
  await expectMode(join(appRoot, "tool"), 0o755);
  await expectMode(join(appRoot, "new.yml"), 0o600);
});

test("rejects setuid and an occupied path before writing a stage", async () => {
  // Given an existing file and an unsafe mode on another create
  const { appRoot, transactions } = await fixture();
  await writeFile(join(appRoot, "kept"), "OLD");

  // When prepare sees the unsafe mode
  const unsafe = await scoped(
    Effect.result(
      transactions.prepare({
        appRoot,
        operations: [{ kind: "create", path: "tool", content: "x", mode: 0o4755 }],
      }),
    ),
  );

  // Then nothing is staged
  expect(unsafe._tag).toBe("Failure");
  if (unsafe._tag === "Failure") expect(unsafe.failure.reason).toBe("path");
  expect(await readdir(appRoot)).toEqual(["kept"]);

  // When prepare sees an occupied path
  const occupied = await scoped(
    Effect.result(
      transactions.prepare({ appRoot, operations: [{ kind: "create", path: "kept", content: "NEW" }] }),
    ),
  );

  // Then the occupant is unchanged and still no stage exists
  expect(occupied._tag).toBe("Failure");
  if (occupied._tag === "Failure") expect(occupied.failure.reason).toBe("conflict");
  expect(await readFile(join(appRoot, "kept"), "utf8")).toBe("OLD");
  expect(await readdir(appRoot)).toEqual(["kept"]);
});

test("leaves a competitor's bytes intact when the name appears immediately before link", async () => {
  // Given a create whose target is planted after the absence check
  const marker = "COMPETITOR-BYTES";
  const { appRoot, transactions } = await fixture((at) =>
    at === "before-create-link" ? Effect.promise(() => writeFile(join(appRoot, "a"), marker)) : Effect.void,
  );
  const before = await scoped(
    Effect.result(
      transactions.run({ appRoot, operations: [{ kind: "create", path: "a", content: "OURS" }] }),
    ),
  );

  // When recovery inspects that conflict
  const recovered = await scoped(Effect.result(transactions.recover(appRoot)));

  // Then the competitor is not truncated and the journal blocks
  expect(before._tag).toBe("Failure");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe(marker);
  expect(recovered._tag).toBe("Failure");
  if (recovered._tag === "Failure") expect(recovered.failure.reason).toBe("blocked");
  expect(await readFile(join(appRoot, "a"), "utf8")).toBe(marker);
  expect((await scoped(transactions.readJournal(appRoot)))?.state).toBe("blocked");
});

test("creates nested parents only while committing and does not chmod an existing directory", async () => {
  // Given a missing nest and a pre-existing directory with a distinctive mode
  const { appRoot, transactions } = await fixture();
  await mkdir(join(appRoot, "keep"), { mode: 0o700 });
  if (process.platform !== "win32") await chmod(join(appRoot, "keep"), 0o700);
  let parentsAbsent = false;

  // When prepare finishes and commit follows
  await scoped(
    Effect.gen(function* () {
      const prepared = yield* transactions.prepare({
        appRoot,
        operations: [
          { kind: "create", path: "nested/deep/file.txt", content: "BODY", mode: 0o640 },
          { kind: "create", path: "keep/file.txt", content: "INSIDE" },
        ],
      });
      yield* Effect.promise(async () => {
        await expect(lstat(join(appRoot, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
        parentsAbsent = true;
      });
      return yield* transactions.commit(prepared);
    }),
  );

  // Then the new parents exist only after commit and the existing directory mode is unchanged
  expect(parentsAbsent).toBe(true);
  expect(await readFile(join(appRoot, "nested/deep/file.txt"), "utf8")).toBe("BODY");
  expect(await readFile(join(appRoot, "keep/file.txt"), "utf8")).toBe("INSIDE");
  await expectMode(join(appRoot, "nested/deep/file.txt"), 0o640);
  await expectMode(join(appRoot, "keep/file.txt"), 0o644);
  if (process.platform !== "win32") {
    expect(await modeOf(join(appRoot, "nested"))).toBe(0o755);
    expect(await modeOf(join(appRoot, "nested/deep"))).toBe(0o755);
    expect(await modeOf(join(appRoot, "keep"))).toBe(0o700);
  }
  expect((await lstat(join(appRoot, "nested"))).isSymbolicLink()).toBe(false);
});

test("does not follow a parent swapped for a symlink before link", async () => {
  // Given a real parent that a checkpoint replaces with a symlink
  const { appRoot, transactions } = await fixture((at) =>
    at === "before-create-link"
      ? Effect.promise(async () => {
          await fs.rename(join(appRoot, "nested"), join(appRoot, "nested.real"));
          await symlink(join(appRoot, "other"), join(appRoot, "nested"));
        })
      : Effect.void,
  );
  await mkdir(join(appRoot, "nested"));
  await mkdir(join(appRoot, "other"));
  await writeFile(join(appRoot, "other/keep"), "SAFE");

  // When publication reaches the link
  const result = await scoped(
    Effect.result(
      transactions.run({ appRoot, operations: [{ kind: "create", path: "nested/file", content: "NEW" }] }),
    ),
  );

  // Then the foreign directory and the symlink are untouched
  expect(result._tag).toBe("Failure");
  expect(await readFile(join(appRoot, "other/keep"), "utf8")).toBe("SAFE");
  await expect(lstat(join(appRoot, "other/file"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(appRoot, "nested"))).isSymbolicLink()).toBe(true);
  const recovered = await scoped(Effect.result(transactions.recover(appRoot)));
  expect(recovered._tag).toBe("Failure");
  if (recovered._tag === "Failure") expect(recovered.failure.reason).toBe("blocked");
  expect(await readFile(join(appRoot, "other/keep"), "utf8")).toBe("SAFE");
  await expect(lstat(join(appRoot, "other/file"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("fails closed when link is unsupported and does not rename or copy", async () => {
  // Given a filesystem that refuses hardlinks
  const { appRoot, transactions } = await fixture();
  const link = spyOn(fs, "link").mockRejectedValue(
    Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" }),
  );
  const rename = spyOn(fs, "rename");
  try {
    // When create tries to publish
    const result = await scoped(
      Effect.result(
        transactions.run({ appRoot, operations: [{ kind: "create", path: "a", content: "BYTES" }] }),
      ),
    );

    // Then no partial target exists and rename was not used
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.reason).toBe("io");
      expect(result.failure.remediation).toBe(HARDLINK_PUBLICATION_REMEDIATION);
      expect(JSON.stringify(result.failure)).not.toContain("BYTES");
    }
    await expect(lstat(join(appRoot, "a"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(rename.mock.calls.some(([, target]) => target === join(appRoot, "a"))).toBe(false);
  } finally {
    link.mockRestore();
    rename.mockRestore();
  }
});

test("stores binary creates without putting those bytes in the journal", async () => {
  // Given opaque bytes
  const bytes = new Uint8Array([0, 255, 10, 65]);
  const { appRoot, transactions } = await fixture();

  // When they are created
  const receipt = await scoped(
    transactions.run({ appRoot, operations: [{ kind: "create", path: "blob", content: bytes }] }),
  );

  // Then the file matches and the receipt carries the digest only
  expect(new Uint8Array(await readFile(join(appRoot, "blob")))).toEqual(bytes);
  expect(receipt.created[0]?.digest).toBe(digestOf(bytes));
});

test("rejects post-init and file bytes as journal fields", () => {
  // Given a journal smuggling an external action
  const input = {
    id: "id",
    root: "/app",
    state: "prepared",
    entries: [],
    postInit: ["run"],
    content: "secret",
  };

  // When the journal schema parses it
  const decoded = Schema.decodeUnknownResult(Journal, { onExcessProperty: "error" })(input);

  // Then external actions are outside transaction recovery
  expect(decoded._tag).toBe("Failure");
});
