import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { AbsolutePath, AppId, ServiceName, SnapshotInfo } from "@lando/sdk/schema";

import { renderDbSnapshots } from "../src/commands/snapshots.ts";

describe("db:snapshots output", () => {
  test("shows recovery metadata needed to choose a snapshot", () => {
    // Given
    const snapshot = SnapshotInfo.make({
      id: "snap-before-upgrade",
      store: { app: AppId.make("sql-app"), store: "sql-app_database_data" },
      digest: "sha256:test",
      sizeBytes: 1_572_864,
      createdAt: DateTime.unsafeMake("2026-09-11T10:00:00Z"),
      label: "before-upgrade",
      metadata: {
        sourceRoot: AbsolutePath.make("/workspace/sql-app"),
        ownerKey: "owner:sql-app",
        repoGroupKey: "repository:sql-app",
        service: ServiceName.make("database"),
        volumeInstanceId: "volume-instance:database",
        family: "mysql",
        version: "8.4",
        imageIdentity: "sha256:mysql-runtime",
        recoveryReason: "manual",
      },
    });

    // When
    const output = renderDbSnapshots(
      { service: "database", snapshots: [snapshot], steps: [] },
      Date.parse("2026-09-12T10:00:00Z"),
    );

    // Then
    expect(output).toContain("snap-before-upgrade");
    expect(output).toContain("1.5 MiB");
    expect(output).toContain("1d");
    expect(output).toContain("mysql 8.4");
    expect(output).toContain("before-upgrade");
    expect(output).toContain("manual");
    expect(output).toContain("owner:sql-app");
    expect(output).toContain("repository:sql-app");
    expect(output).toContain("/workspace/sql-app");
  });
});
