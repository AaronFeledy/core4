import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import * as DiskStateStore from "@lando/state-store/service";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { sqliteSnapshotStore } from "../src/sqlite-path.ts";
import { sqliteRetentionSelection } from "../src/sqlite-retention.ts";
import { persistSqliteSnapshot } from "../src/sqlite-snapshot.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";

afterEach(cleanupSqlTestDeps);
for (const recovery of [true, false]) {
  test(`${recovery ? "automatic" : "manual"} SQLite retention counts each service and path independently`, async () => {
    const f = await makeRetentionTestDeps();
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const paths = makeLandoPaths({
          userConfRoot: join(f.harness.root, "conf"),
          userDataRoot: join(f.harness.root, "data"),
          userCacheRoot: join(f.harness.root, "cache"),
          env: {},
        });
        const stateStore = yield* StateStore.pipe(Effect.provide(DiskStateStore.layer));
        const deps = { paths, stateStore };
        const payload = join(f.harness.root, "payload.sqlite");
        writeFileSync(payload, "SQLite format 3\0retention fixture");
        let time = 1000;
        const seed = (name: string, path: string, reason: "manual" | "reset") =>
          Effect.gen(function* () {
            yield* TestClock.setTime(time++);
            return (yield* persistSqliteSnapshot(
              deps,
              f.deps.plan,
              { kind: "file", name, type: "php:8.3", family: "sqlite", path },
              payload,
              "3.45.0",
              { recoveryReason: reason },
            )).id;
          });
        const reason = recovery ? "reset" : "manual";
        const foreignService = yield* seed("other", "data/site.sqlite", reason);
        const foreignPath = yield* seed("database", "data/other.sqlite", reason);
        const matching: string[] = [];
        for (let index = 0; index < 5; index++)
          matching.push(yield* seed("database", "data/site.sqlite", reason));
        const opposite = yield* seed("database", "data/site.sqlite", recovery ? "manual" : "reset");
        const filter = {
          app: AppId.make("sql-app"),
          store: sqliteSnapshotStore("data/site.sqlite"),
          service: ServiceName.make("database"),
        };
        const snapshots = yield* f.mover.listSnapshots(filter);
        const selection = sqliteRetentionSelection(snapshots, "data/site.sqlite", 3, recovery, [
          ...matching.slice(0, 2),
          opposite,
        ]);
        const removed = yield* f.mover.pruneSnapshots({
          filter,
          recovery,
          keepLatest: selection.keepLatest,
          retainSnapshotIds: selection.retainSnapshotIds,
        });
        const remaining = yield* f.mover.listSnapshots({ app: filter.app });
        return { matching, removed, remaining, foreignService, foreignPath, opposite };
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
    expect([...outcome.removed].sort()).toEqual(outcome.matching.slice(2, 4).sort());
    expect(outcome.remaining.map((snapshot) => snapshot.id).sort()).toEqual(
      [
        outcome.foreignService,
        outcome.foreignPath,
        outcome.opposite,
        ...outcome.matching.slice(0, 2),
        ...outcome.matching.slice(4),
      ].sort(),
    );
  });
}
