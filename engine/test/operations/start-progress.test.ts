import { describe, expect, test } from "bun:test";

import { startChildTaskId } from "@lando/sdk/task-progress";

import {
  applyTreeId,
  startFileSyncTreeId,
  startGlobalTreeId,
  startHostProxyTreeId,
  startRoutesTreeId,
} from "../../src/operations/start-progress.ts";

describe("start-progress task tree ids", () => {
  test("prefixes start-owned child ids with the parent id", () => {
    const parentId = startFileSyncTreeId("app-1");
    expect(startChildTaskId(parentId, "setup")).toBe("start-file-sync-app-1:setup");
    expect(applyTreeId("app-1")).toBe("apply-app-1");
    expect(startGlobalTreeId("app-1")).toBe("start-global-app-1");
    expect(startHostProxyTreeId("app-1")).toBe("start-host-proxy-app-1");
    expect(startRoutesTreeId("app-1")).toBe("start-routes-app-1");
  });
});
