import { expect, test } from "bun:test";
import { SqlRecoveryUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { sqliteSnapshotCatalogFailure } from "../src/sqlite-snapshot.ts";

const upgrade =
  "A newer Lando wrote /data/snap.json (envelope version 4; this Lando supports 1). Run the newer Lando that wrote it or upgrade Lando. Leave the file in place.";

test("sqliteSnapshotCatalogFailure keeps newer-version upgrade remediation", () => {
  const cause = new StateStoreError({
    reason: "newer-version",
    operation: "set",
    path: "/data/snap.json",
    storedVersion: 4,
    supportedVersion: 1,
    remediation: upgrade,
  });
  const failed = sqliteSnapshotCatalogFailure("database", "Cannot write the SQLite snapshot catalog.", cause);
  expect(failed).toBeInstanceOf(SqlRecoveryUnavailableError);
  expect(failed.remediation).toBe(upgrade);
  expect(failed.reason).toBe("newer-version");
});

test("sqliteSnapshotCatalogFailure keeps domain fallback for other causes", () => {
  const failed = sqliteSnapshotCatalogFailure(
    "database",
    "Cannot write the SQLite snapshot catalog.",
    new Error("disk"),
  );
  expect(failed.remediation).toContain("snapshot store");
  expect(failed.reason).toContain("disk");
});
