import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, AppId, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { DateTime, Effect, Exit } from "effect";
import { packSqliteTarFile } from "../src/sqlite-archive.ts";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { copySqliteSnapshotArchive } from "../src/sqlite-snapshot-transfer.ts";
import { persistSqliteSnapshot } from "../src/sqlite-snapshot.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
for (const operation of ["publish", "read"] as const) {
  test(`SQLite ${operation} refuses an escaping snapshot store symlink`, async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlite-containment-"));
    roots.push(root);
    const paths = makeLandoPaths({ userDataRoot: join(root, "data"), env: {} });
    const owner = planAppIdentity({ root: AbsolutePath.make(root) });
    const store = { app: AppId.make("app"), store: sqliteSnapshotStore("db.sqlite") };
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(paths.ownerSnapshotsDir(owner.ownerKey), { recursive: true });
    await symlink(outside, join(paths.ownerSnapshotsDir(owner.ownerKey), store.store));
    const payload = join(root, "db.sqlite");
    await writeFile(payload, "SQLite format 3\0private data");
    const packed = await packSqliteTarFile(payload, join(outside, "snapshot.tar"));
    const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
    const deps = { paths, stateStore };
    const result = await Effect.runPromiseExit(
      operation === "publish"
        ? persistSqliteSnapshot(
            deps,
            { id: "app", name: "app", root, services: {} },
            { kind: "file", family: "sqlite", name: "appserver", type: "php", path: "db.sqlite" },
            payload,
            "3.45.0",
            { id: "new" },
          )
        : copySqliteSnapshotArchive(
            deps,
            {
              owner,
              store,
              id: "snapshot",
              format: "tar",
              createdAt: DateTime.nowUnsafe(),
              digest: packed.digest,
              sizeBytes: packed.sizeBytes,
            },
            join(root, "staged.tar"),
            "appserver",
          ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(await Bun.file(join(outside, "new.tar")).exists()).toBe(false);
    expect(await Bun.file(join(root, "staged.tar")).exists()).toBe(false);
  });
}
