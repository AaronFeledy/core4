import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  SnapshotInfo,
  appIdentityKey,
  planAppIdentity,
  snapshotHandle,
} from "@lando/sdk/schema";
import { DateTime, Schema } from "effect";

test("preserves planned ownership when the plan carries an identity", () => {
  // Given
  const identity = {
    appRoot: AbsolutePath.make("/canonical"),
    ownerKey: "planned-owner",
    repoGroupKey: "repository",
  };
  // When
  const owner = planAppIdentity({ root: AbsolutePath.make("/older-root"), identity });
  // Then
  expect(owner).toBe(identity);
});

test("derives canonical ownership when an older plan lacks identity", () => {
  // Given
  const root = AbsolutePath.make("/canonical");
  // When
  const owner = planAppIdentity({ root });
  // Then
  expect(owner).toEqual({ appRoot: root, ownerKey: appIdentityKey("owner", root) });
});

test("retains owner catalog identity when projecting a snapshot handle", () => {
  // Given
  const info: SnapshotInfo = {
    owner: { appRoot: AbsolutePath.make("/canonical"), ownerKey: "owner", repoGroupKey: "group" },
    id: "snapshot",
    store: { app: AppId.make("display-name"), store: "database" },
    digest: "digest",
    sizeBytes: 4,
    createdAt: DateTime.makeUnsafe(0),
  };
  // When
  const handle = snapshotHandle(info);
  // Then
  expect(handle).toEqual({
    ownerKey: "owner",
    id: "snapshot",
    store: { app: AppId.make("display-name"), store: "database" },
  });
});

test("rejects ownerless snapshot records at the schema boundary", () => {
  // Given
  const record = {
    id: "snapshot",
    store: { app: "display-name", store: "database" },
    digest: "digest",
    sizeBytes: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  // When
  const decoded = Schema.decodeUnknownOption(SnapshotInfo)(record);
  // Then
  expect(decoded._tag).toBe("None");
});
