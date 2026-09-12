import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import type { StateStoreShape } from "@lando/sdk/services";

export const SqlSeedStatus = Schema.Literal("fresh", "in-progress", "seeded", "failed");
export type SqlSeedStatus = typeof SqlSeedStatus.Type;

const SqlSeedState = Schema.Struct({ status: SqlSeedStatus });
type SqlSeedState = typeof SqlSeedState.Type;

export const sqlSeedState = (store: StateStoreShape, volumeInstanceId: string) =>
  store.open<SqlSeedState, SqlSeedState>({
    root: "userData",
    namespace: "sql-seeds",
    key: `${createHash("sha256").update(volumeInstanceId).digest("hex")}.json`,
    schema: SqlSeedState,
    version: 1,
    lock: "advisory",
    default: { status: "fresh" },
  });

export const setSqlSeedStatus = (store: StateStoreShape, volumeInstanceId: string, status: SqlSeedStatus) =>
  sqlSeedState(store, volumeInstanceId).pipe(Effect.flatMap((bucket) => bucket.set({ status })));
