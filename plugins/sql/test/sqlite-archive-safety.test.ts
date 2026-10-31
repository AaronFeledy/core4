import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeUstarHeader } from "@lando/container-runtime/tar";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { SnapshotInfo } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option } from "effect";

import {
  packSqliteTar,
  packSqliteTarFile,
  unpackSqliteTar,
  unpackSqliteTarFile,
} from "../src/sqlite-archive.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import {
  type SqliteSnapshotDeps,
  copySqliteSnapshotArchive,
  persistSqliteSnapshot,
  stageVerifiedSqliteImport,
} from "../src/sqlite-snapshot.ts";

const payload = new TextEncoder().encode("SQLite format 3\0snapshot payload");
const roots: string[] = [];
const temporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-sqlite-archive-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const archiveWithHeader = (input: Parameters<typeof encodeUstarHeader>[0]) => {
  const archive = packSqliteTar(payload);
  archive.set(encodeUstarHeader(input));
  return archive;
};

const invalidArchives = () => {
  const damagedChecksum = packSqliteTar(payload);
  damagedChecksum[100] = 55;
  const extraEntry = new Uint8Array(packSqliteTar(payload).length + 512);
  extraEntry.set(packSqliteTar(payload));
  extraEntry.set(encodeUstarHeader({ name: "other", size: 0, mode: 0o644, typeflag: "0" }), 1024);
  const nonzeroPadding = packSqliteTar(payload);
  nonzeroPadding[512 + payload.length] = 1;
  return [
    ["checksum mismatch", damagedChecksum],
    [
      "wrong entry name",
      archiveWithHeader({ name: "other.sqlite", size: payload.length, mode: 0o644, typeflag: "0" }),
    ],
    [
      "symbolic link",
      archiveWithHeader({
        name: "database.sqlite",
        size: payload.length,
        mode: 0o644,
        typeflag: "2",
        linkName: "other",
      }),
    ],
    ["truncated terminator", packSqliteTar(payload).slice(0, -1)],
    ["extra entry", extraEntry],
    ["nonzero padding", nonzeroPadding],
    ["non-SQLite payload", packSqliteTar(new TextEncoder().encode("CREATE TABLE items(id);"))],
  ] as const;
};

describe("SQLite snapshot archive validation", () => {
  for (const [name, archive] of invalidArchives()) {
    test(`rejects ${name} without changing the extraction destination`, async () => {
      const root = await temporaryRoot();
      const source = join(root, "snapshot.tar");
      const destination = join(root, "database.sqlite");
      await writeFile(source, archive);
      await writeFile(destination, "keep previous destination");
      expect(unpackSqliteTar(archive)).toBeUndefined();
      expect(await unpackSqliteTarFile(source, destination)).toBe(false);
      expect(await readFile(destination, "utf8")).toBe("keep previous destination");
    });
  }

  test("streams a valid archive and extracts the same database bytes", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.sqlite");
    const archive = join(root, "snapshot.tar");
    const destination = join(root, "restored.sqlite");
    await writeFile(source, payload);
    const packed = await packSqliteTarFile(source, archive);
    expect(packed.digest).toBe(new Bun.CryptoHasher("sha256").update(await readFile(archive)).digest("hex"));
    expect(packed.sizeBytes).toBe((await readFile(archive)).length);
    if (process.platform !== "win32") expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(await unpackSqliteTarFile(archive, destination)).toBe(true);
    expect(new Uint8Array(await readFile(destination))).toEqual(payload);
  });

  test("verifies archive catalog digest and size before publishing restore staging", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "sqlite-store");
    await mkdir(directory);
    const archive = packSqliteTar(payload);
    await writeFile(join(directory, "snapshot.tar"), archive);
    const destination = join(root, "staged.tar");
    const info = {
      id: "snapshot",
      owner: { ownerKey: "owner" },
      store: { store: "sqlite-store" },
      format: "tar",
      sizeBytes: archive.length,
      digest: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
    } as SnapshotInfo;
    const deps = { paths: { ownerSnapshotsDir: () => root } } as unknown as SqliteSnapshotDeps;
    for (const overrides of [
      { digest: "0".repeat(64) },
      { sizeBytes: archive.length + 1 },
      { format: "tar.gz" },
    ]) {
      await writeFile(destination, "keep staged destination");
      const exit = await Effect.runPromiseExit(
        copySqliteSnapshotArchive(deps, { ...info, ...overrides } as SnapshotInfo, destination, "appserver"),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await readFile(destination, "utf8")).toBe("keep staged destination");
    }
    await Effect.runPromise(copySqliteSnapshotArchive(deps, info, destination, "appserver"));
    expect([...(await readFile(destination))]).toEqual([...archive]);
  });

  test("preserves and identifies a captured archive when catalog persistence fails", async () => {
    const root = await temporaryRoot();
    const source = join(root, "captured.sqlite");
    await writeFile(source, payload);
    const deps = {
      paths: { ownerSnapshotsDir: () => root },
      stateStore: { open: () => Effect.fail("catalog unavailable") },
    } as unknown as SqliteSnapshotDeps;
    const target = {
      kind: "file",
      name: "appserver",
      type: "php:8.3",
      family: "sqlite",
      path: "data/app.sqlite",
    } as const;
    const exit = await Effect.runPromiseExit(
      persistSqliteSnapshot(deps, { id: "app", name: "app", root, services: {} }, target, source, "3.54.1", {
        id: "retained",
        targetIdentity: JSON.stringify([
          "sqlite-target-v1",
          "docker",
          target.path,
          "bind",
          root,
          "app.sqlite",
        ]),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
    const archive = join(root, sqliteSnapshotStore(target.path), "retained.tar");
    if (error instanceof SqlRecoveryUnavailableError) {
      expect(error.remediation).toContain(archive);
      expect(error.remediation).toContain("not cataloged");
    }
    expect(unpackSqliteTar(new Uint8Array(await readFile(archive)))).toEqual(payload);
    expect(new Uint8Array(await readFile(source))).toEqual(payload);
  });

  test("rejects an uncompressed source changed after selection before publishing staging", async () => {
    const root = await temporaryRoot();
    const source = join(root, "import.sql");
    const destination = join(root, "staged.sql");
    const approved = "CREATE TABLE approved(id);";
    const digest = new Bun.CryptoHasher("sha256").update(approved).digest("hex");
    await writeFile(source, "CREATE TABLE replacement(id);");
    await writeFile(destination, "keep staged destination");
    const exit = await Effect.runPromiseExit(
      stageVerifiedSqliteImport(source, destination, digest, "appserver"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("keep staged destination");
    await writeFile(source, approved);
    await Effect.runPromise(stageVerifiedSqliteImport(source, destination, digest, "appserver"));
    expect(await readFile(destination, "utf8")).toBe(approved);
    if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o644);
  });
});
