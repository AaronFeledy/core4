import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AbsolutePath,
  AppId,
  type SnapshotHandle,
  SnapshotInfo,
  appIdentityKey,
  planAppIdentity,
  snapshotHandle,
} from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { run, runScoped, store, withCatalog } from "./catalog-fixture.ts";
import { fixtureVolume } from "./support.ts";

test("same app and store produce separate owner trees and owner listing reads only its tree", () =>
  withCatalog(async (f) => {
    // Given two owners of the same app/store, with a corrupt unrelated catalog.
    const first = await runScoped(f.mover().snapshot(store));
    const other = planAppIdentity({ root: AbsolutePath.make(join(f.root, "other-app")) });
    const source = fixtureVolume(store);
    const second = await runScoped(
      f
        .mover(
          f.provider({
            listVolumes: () =>
              Effect.succeed([{ ...source, identity: { ...source.identity, ownerRoot: other.appRoot } }]),
          }),
        )
        .snapshot(store, { repoGroupKey: "group-hint" }),
    );
    const secondInfo = await run(f.mover().resolveSnapshot(second.id, { ownerKey: other.ownerKey }));
    expect(secondInfo.owner).toEqual({ ...other, repoGroupKey: "group-hint" });
    const secondPath = join(f.paths.ownerSnapshotsDir(other.ownerKey), store.store, `${second.id}.json`);
    await writeFile(secondPath, "broken");
    // When listing the first owner, no other tree is read.
    const infos = await run(f.mover().listSnapshots({ ownerKey: first.ownerKey }));
    // Then its single record is returned and both directories exist.
    expect(infos.map((info) => info.id)).toEqual([first.id]);
    expect((await readdir(f.paths.snapshotsDir)).sort()).toEqual([first.ownerKey, other.ownerKey].sort());
    expect((await run(f.mover().listSnapshots({}).pipe(Effect.result)))._tag).toBe("Failure");
  }));

test("listing is ordered oldest first, then by id, across owner trees", () =>
  withCatalog(async (f) => {
    // Given snapshots in two owner trees, whose directory order the filesystem decides.
    const first = await runScoped(f.mover().snapshot(store));
    const other = planAppIdentity({ root: AbsolutePath.make(join(f.root, "other-app")) });
    const source = fixtureVolume(store);
    const second = await runScoped(
      f
        .mover(
          f.provider({
            listVolumes: () =>
              Effect.succeed([{ ...source, identity: { ...source.identity, ownerRoot: other.appRoot } }]),
          }),
        )
        .snapshot(store),
    );
    // When listing every owner.
    const infos = await run(f.mover().listSnapshots({}));
    // Then the order follows creation time, with ids breaking ties.
    const expected = [...infos].sort(
      (left, right) =>
        left.createdAt.epochMilliseconds - right.createdAt.epochMilliseconds ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    expect(infos.map((info) => info.id)).toEqual(expected.map((info) => info.id));
    expect(new Set(infos.map((info) => info.id))).toEqual(new Set([first.id, second.id]));
  }));

test.each(["", ".", "..", "a/b", "a\\b", "a\0b", "C:drive"])(
  "rejects unsafe snapshot store/id segment %j",
  (segment) =>
    withCatalog(async (f) => {
      // Given untrusted handles and a source store containing the segment.
      const handle = snapshotHandle(f.info());
      const handles: SnapshotHandle[] = [
        { ...handle, id: segment },
        { ...handle, store: { ...store, store: segment } },
      ];
      // When mutation resolves those addresses, path validation fails before action.
      const errors = await run(
        Effect.forEach(handles, (address) => f.mover().removeSnapshot(address).pipe(Effect.flip)),
      );
      const creation = await runScoped(
        f
          .mover()
          .snapshot({ ...store, store: segment })
          .pipe(Effect.result),
      );
      // Then nothing is persisted or acquired.
      expect(errors.map((error) => error._tag)).toEqual(["DataTransferError", "DataTransferError"]);
      expect(creation._tag).toBe("Failure");
      expect(f.artifacts.size).toBe(0);
      expect(await f.files()).toEqual([]);
    }),
);

test.each(["bad", "A".repeat(64), "../outside"])("rejects invalid owner key %s", (ownerKey) =>
  withCatalog(async (f) => {
    // Given an invalid owner address.
    const handle = { ...snapshotHandle(f.info()), ownerKey };
    // When listing and removing it.
    const results = await run(
      Effect.all([
        f.mover().listSnapshots({ ownerKey }).pipe(Effect.result),
        f.mover().removeSnapshot(handle).pipe(Effect.result),
      ]),
    );
    // Then both fail without creating the catalog.
    expect(results.map((result) => result._tag)).toEqual(["Failure", "Failure"]);
    expect(await f.files()).toEqual([]);
  }),
);

test.each([".", "..", "bad:name"])("rejects unsafe sidecar id %j during listing", (id) =>
  withCatalog(async (f) => {
    // Given a valid sidecar stored under an unsafe snapshot id.
    await f.put(f.info());
    const directory = join(f.paths.ownerSnapshotsDir(f.owner.ownerKey), store.store);
    const bytes = await readFile(join(directory, "snapshot.json"), "utf8");
    const path = join(directory, `${id}.json`);
    await writeFile(path, bytes);

    // When listing the owner catalog.
    const result = await run(f.mover().listSnapshots({ ownerKey: f.owner.ownerKey }).pipe(Effect.result));

    // Then path validation rejects the address without rewriting its evidence.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DataTransferError", operation: "validate-path" },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
  }),
);

test.each(["owner", "store", "sidecar", "archive"])("rejects escaping %s symlink", (location) =>
  withCatalog(async (f) => {
    // Given an owner catalog whose addressed component points outside snapshotsDir.
    const info = f.info();
    await f.put(info);
    const ownerDir = f.paths.ownerSnapshotsDir(info.owner.ownerKey);
    const storeDir = join(ownerDir, store.store);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    if (location === "owner" || location === "store") {
      const { rename } = await import("node:fs/promises");
      const path = location === "owner" ? ownerDir : storeDir;
      await rename(path, join(outside, "saved"));
      await symlink(join(outside, "saved"), path);
    } else {
      const path = join(storeDir, `snapshot.${location === "sidecar" ? "json" : "tar"}`);
      if (location === "sidecar") await unlink(path);
      await symlink(join(outside, "missing"), path);
    }
    // When the addressed snapshot is removed.
    const result = await run(f.mover().removeSnapshot(snapshotHandle(info)).pipe(Effect.result));
    // Then containment fails closed.
    expect(result._tag).toBe("Failure");
  }),
);

test.each(["version", "json", "schema", "owner-hash", "owner-path", "store", "id"])(
  "fails visibly for %s sidecar corruption",
  (kind) =>
    withCatalog(async (f) => {
      // Given a real framed sidecar corrupted in one independent way.
      const info = f.info();
      await f.put(info);
      const data = Schema.encodeSync(SnapshotInfo)(info);
      const modified =
        kind === "owner-hash"
          ? { ...data, owner: { ...data.owner, appRoot: "/foreign" } }
          : kind === "owner-path"
            ? { ...data, owner: { appRoot: "/foreign", ownerKey: appIdentityKey("owner", "/foreign") } }
            : kind === "store"
              ? { ...data, store: { ...data.store, store: "other" } }
              : kind === "id"
                ? { ...data, id: "other" }
                : kind === "schema"
                  ? {}
                  : data;
      const path = join(f.paths.ownerSnapshotsDir(f.owner.ownerKey), store.store, "snapshot.json");
      const bytes =
        kind === "json" ? "broken" : JSON.stringify({ version: kind === "version" ? 2 : 1, data: modified });
      await writeFile(path, bytes);
      // When scanning the catalog.
      const result = await run(f.mover().listSnapshots({}).pipe(Effect.result));
      // Then corruption fails without quarantine or rewriting ownership evidence.
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataTransferError" } });
      expect(await readFile(path, "utf8")).toBe(bytes);
    }),
);

test("a sidecar that vanishes after enumeration is absent", () =>
  withCatalog(async (f) => {
    // Given a real bucket removed just before its read.
    await f.put(f.info());
    const storage = StateStore.of({
      ...f.stateStore,
      open: (spec) =>
        f.stateStore.open(spec).pipe(
          Effect.map((bucket) => ({
            ...bucket,
            get: Effect.promise(() => unlink(bucket.path)).pipe(Effect.andThen(bucket.get)),
          })),
        ),
    });
    // When listing from disk.
    const listed = await run(f.mover(f.recording, storage).listSnapshots({}));
    // Then the missing entry is not corruption.
    expect(listed).toEqual([]);
  }));

test("last removal removes its owner tree and listing never recreates it", () =>
  withCatalog(async (f) => {
    // Given one snapshot in an owner tree.
    const handle = await runScoped(f.mover().snapshot(store));
    // When removing it and listing that owner again.
    await run(f.mover().removeSnapshot(handle));
    const listed = await run(f.mover().listSnapshots({ ownerKey: handle.ownerKey }));
    // Then there is no owner directory or record.
    expect(listed).toEqual([]);
    expect(await readdir(f.paths.snapshotsDir)).toEqual([]);
  }));

test("concurrent removals acquire the artifact only once", () =>
  withCatalog(async (f) => {
    // Given one durable snapshot and two simultaneous removers.
    const handle = await runScoped(f.mover().snapshot(store));
    // When both remove using the same owner-bound address.
    const results = await run(
      Effect.all(
        [
          f.mover().removeSnapshot(handle).pipe(Effect.result),
          f.mover().removeSnapshot(handle).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      ),
    );
    // Then one succeeds, one reports absence, and the provider sees one deletion.
    expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
    expect(f.removals).toEqual([handle.id]);
  }));

test("a handle cannot substitute another app for the addressed sidecar", () =>
  withCatalog(async (f) => {
    // Given a recorded snapshot and a forged app in its handle.
    const handle = await runScoped(f.mover().snapshot(store));
    // When resolving the forged handle for removal.
    const result = await run(
      f
        .mover()
        .removeSnapshot({ ...handle, store: { ...store, app: AppId.make("foreign") } })
        .pipe(Effect.result),
    );
    // Then validation fails before provider mutation.
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataTransferError" } });
    expect(f.removals).toEqual([]);
  }));

test("id resolution cannot escape its supplied owner scope", () =>
  withCatalog(async (f) => {
    // Given a snapshot whose id is known but whose owner is outside the requested scope.
    const handle = await runScoped(f.mover().snapshot(store));
    // When resolving that exact id within a different owner.
    const result = await run(
      f
        .mover()
        .resolveSnapshot(handle.id, { ownerKey: appIdentityKey("owner", "/other") })
        .pipe(Effect.result),
    );
    // Then the id is absent, not a catalog-wide fallback match.
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotNotFoundError" } });
  }));
