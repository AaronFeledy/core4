import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AbsolutePath, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect } from "effect";
import { persistSqliteSnapshot } from "../src/sqlite-snapshot.ts";
import { openSqliteSidecar } from "./support/sqlite-sidecar.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("integration sidecar readers open SQLite metadata written at the current version", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-sidecar-version-"));
  roots.push(root);
  const paths = makeLandoPaths({ userDataRoot: root, env: {} });
  const owner = planAppIdentity({ root: AbsolutePath.make(root) });
  const stateStore = await Effect.runPromise(StateStore.pipe(Effect.provide(DiskStateStore.layer)));
  const payload = join(root, "db.sqlite");
  await writeFile(payload, "SQLite format 3\0version fixture");
  const target = {
    kind: "file",
    family: "sqlite",
    name: "appserver",
    type: "php",
    path: "db.sqlite",
  } as const;
  const snapshot = await Effect.runPromise(
    persistSqliteSnapshot(
      { paths, stateStore },
      { id: "app", name: "app", root, services: {} },
      target,
      payload,
      "3.45.0",
      {},
    ),
  );
  const info = await Effect.runPromise(
    Effect.gen(function* () {
      const bucket = yield* openSqliteSidecar(
        stateStore,
        join(paths.ownerSnapshotsDir(owner.ownerKey), snapshot.store.store),
        snapshot.id,
      );
      return yield* bucket.get;
    }),
  );
  expect(info?.id).toBe(snapshot.id);
  expect(info?.metadata).toMatchObject({ family: "sqlite", path: "db.sqlite" });
});
