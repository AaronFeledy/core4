import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  SnapshotInfo,
  SnapshotMetadata,
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

test("SQLite snapshot metadata records path and provenance without physical storage identity", () => {
  const metadata = {
    service: "appserver",
    family: "sqlite",
    path: "data/site.sqlite",
    version: "3.45.0",
    recoveryReason: "manual",
  };
  const decode = Schema.decodeUnknownOption(SnapshotMetadata);
  expect(decode(metadata)._tag).toBe("Some");
  expect(decode({ ...metadata, family: "postgres" })._tag).toBe("None");
  expect(
    decode({
      service: "database",
      family: "postgres",
      version: "16",
      recoveryReason: "manual",
      volumeInstanceId: "generation",
      imageIdentity: "sha256:image",
    })._tag,
  ).toBe("Some");
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
