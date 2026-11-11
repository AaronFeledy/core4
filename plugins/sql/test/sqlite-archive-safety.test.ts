import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeUstarHeader } from "@lando/container-runtime/tar";
import { makeLandoPaths } from "@lando/paths";
import { SqlRecoveryUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type SnapshotInfo, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { DateTime, Effect, Exit } from "effect";

import {
  packSqliteTar,
  packSqliteTarFile,
  unpackSqliteTar,
  unpackSqliteTarFile,
} from "../src/sqlite-archive.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { copySqliteSnapshotArchive, stageVerifiedSqliteImport } from "../src/sqlite-snapshot-transfer.ts";
import { persistSqliteSnapshot } from "../src/sqlite-snapshot.ts";

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
    const archiveBytes = await readFile(archive);
    expect(packed.digest).toBe(new Bun.CryptoHasher("sha256").update(archiveBytes).digest("hex"));
    expect(packed.sizeBytes).toBe(archiveBytes.length);
    if (process.platform !== "win32") expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect(await unpackSqliteTarFile(archive, destination)).toBe(true);
    expect(new Uint8Array(await readFile(destination))).toEqual(payload);
  });

  test("verifies archive catalog digest and size before publishing restore staging", async () => {
    const root = await temporaryRoot();
    const paths = makeLandoPaths({ userDataRoot: root, env: {} });
    const owner = planAppIdentity({ root: AbsolutePath.make(root) });
    const directory = join(paths.ownerSnapshotsDir(owner.ownerKey), "sqlite-store");
    await mkdir(directory, { recursive: true });
    const archive = packSqliteTar(payload);
    await writeFile(join(directory, "snapshot.tar"), archive);
    const destination = join(root, "staged.tar");
    const info = {
      id: "snapshot",
      owner,
      store: { app: AppId.make("app"), store: "sqlite-store" },
      format: "tar" as const,
      createdAt: DateTime.nowUnsafe(),
      sizeBytes: archive.length,
      digest: new Bun.CryptoHasher("sha256").update(archive).digest("hex"),
    } satisfies SnapshotInfo;
    const deps = { paths };
    for (const overrides of [
      { digest: "0".repeat(64) },
      { sizeBytes: archive.length + 1 },
      { format: "tar.gz" as const },
    ]) {
      await writeFile(destination, "keep staged destination");
      const exit = await Effect.runPromiseExit(
        copySqliteSnapshotArchive(deps, { ...info, ...overrides }, destination, "appserver"),
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
    const paths = makeLandoPaths({ userDataRoot: root, env: {} });
    const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
    const deps = {
      paths,
      stateStore: {
        ...stateStore,
        open: () =>
          Effect.fail(
            new StateStoreError({
              reason: "io",
              operation: "open",
              cause: "catalog unavailable",
              remediation: "Retry.",
            }),
          ),
      },
    };
    const target = {
      kind: "file",
      name: "appserver",
      type: "php:8.3",
      family: "sqlite",
      path: "data/app.sqlite",
    } as const;
    const error = await Effect.runPromise(
      persistSqliteSnapshot(deps, { id: "app", name: "app", root, services: {} }, target, source, "3.54.1", {
        id: "retained",
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SqlRecoveryUnavailableError);
    const owner = planAppIdentity({ root: AbsolutePath.make(root) });
    const archive = join(
      paths.ownerSnapshotsDir(owner.ownerKey),
      sqliteSnapshotStore(target.path),
      "retained.tar",
    );
    expect(error.remediation).toContain(archive);
    expect(error.remediation).toContain("not cataloged");
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
