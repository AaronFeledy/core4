import { AbsolutePath, SNAPSHOT_INFO_VERSION, SnapshotInfo } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";

export const openSqliteSidecar = (stateStore: StateStoreShape, directory: string, id: string) =>
  stateStore.open({
    root: { path: AbsolutePath.make(directory) },
    key: `${id}.json`,
    schema: SnapshotInfo,
    version: SNAPSHOT_INFO_VERSION,
    codec: "json",
    onCorrupt: "fail",
  });
