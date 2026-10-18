import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, type SnapshotInfo, type VolumeSnapshotArtifact } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Clock, DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { SNAPSHOT_ORPHAN_GRACE_MS, orphanedSnapshotMethods } from "../src/orphaned-snapshots.ts";

const artifact = (
  id: string,
  age: number,
  labels: Readonly<Record<string, string>>,
): VolumeSnapshotArtifact => ({
  ref: { provider: "test", id, digest: `sha256:${id}`, sizeBytes: 10, format: "native" },
  createdAt: DateTime.makeUnsafe(10000000 - age),
  labels,
});
const owned = { "dev.lando.volume-snapshot": "TRUE", "dev.lando.snapshot-store": "ours" };

test("finds only old unindexed snapshots owned by this store or unmarked legacy images", async () => {
  const artifacts = [
    artifact("orphan", 2 * SNAPSHOT_ORPHAN_GRACE_MS, owned),
    artifact("indexed", 2 * SNAPSHOT_ORPHAN_GRACE_MS, owned),
    artifact("recent", SNAPSHOT_ORPHAN_GRACE_MS - 1, owned),
    artifact("foreign", 2 * SNAPSHOT_ORPHAN_GRACE_MS, { ...owned, "dev.lando.snapshot-store": "theirs" }),
    artifact("legacy", 2 * SNAPSHOT_ORPHAN_GRACE_MS, {}),
    artifact("marked-without-store", 2 * SNAPSHOT_ORPHAN_GRACE_MS, { "dev.lando.volume-snapshot": "TRUE" }),
  ];
  const indexed = artifacts[1];
  if (indexed === undefined) throw new Error("Missing fixture");
  const index: SnapshotInfo[] = [
    {
      id: "indexed",
      store: { app: AppId.make("app"), store: "data" },
      createdAt: indexed.createdAt,
      sizeBytes: 10,
      digest: indexed.ref.digest,
      native: indexed.ref,
    },
  ];
  const mover = orphanedSnapshotMethods({
    provider: { ...TestRuntimeProvider, listVolumeSnapshots: () => Effect.succeed(artifacts) },
    storeIdentity: Effect.succeed("ours"),
    index: Effect.succeed(index),
  });
  const found = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(10000000);
      return yield* mover.findOrphanedSnapshots;
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(found.map((image) => image.ref.id)).toEqual(["orphan", "legacy"]);
});

test("rechecks the current index before removing a previously discovered orphan", async () => {
  const image = artifact("race", 2 * SNAPSHOT_ORPHAN_GRACE_MS, owned);
  const index: SnapshotInfo[] = [];
  const removed: string[] = [];
  const mover = orphanedSnapshotMethods({
    provider: {
      ...TestRuntimeProvider,
      listVolumeSnapshots: () => Effect.succeed([image]),
      removeVolumeSnapshot: (ref) =>
        Effect.sync(() => {
          removed.push(ref.id);
        }),
    },
    storeIdentity: Effect.succeed("ours"),
    index: Effect.sync(() => [...index]),
  });
  const discovered = await Effect.runPromise(mover.findOrphanedSnapshots);
  index.push({
    id: "race",
    store: { app: AppId.make("app"), store: "data" },
    createdAt: image.createdAt,
    sizeBytes: 10,
    digest: image.ref.digest,
    native: image.ref,
  });
  const result = await Effect.runPromise(
    Effect.result(Effect.forEach(discovered, mover.removeOrphanedSnapshot)),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "DataTransferError", operation: "removeOrphanedSnapshot" },
  });
  expect(removed).toEqual([]);
});

test("removes an eligible image but refuses young and foreign images", async () => {
  const removed: string[] = [];
  const now = await Effect.runPromise(Clock.currentTimeMillis);
  const images = [
    artifact("old", 2 * SNAPSHOT_ORPHAN_GRACE_MS, owned),
    { ...artifact("young", 0, owned), createdAt: DateTime.makeUnsafe(now) },
    artifact("foreign", 2 * SNAPSHOT_ORPHAN_GRACE_MS, { ...owned, "dev.lando.snapshot-store": "theirs" }),
  ];
  const mover = orphanedSnapshotMethods({
    provider: {
      ...TestRuntimeProvider,
      listVolumeSnapshots: () => Effect.succeed(images),
      removeVolumeSnapshot: (ref) =>
        Effect.sync(() => {
          removed.push(ref.id);
        }),
    },
    storeIdentity: Effect.succeed("ours"),
    index: Effect.succeed([]),
  });
  const results = await Effect.runPromise(
    Effect.forEach(images, (image) => Effect.result(mover.removeOrphanedSnapshot(image))),
  );
  expect(removed).toEqual(["old"]);
  expect(results.map((result) => result._tag)).toEqual(["Success", "Failure", "Failure"]);
});

test("refuses removal when the tag now names another image or the runtime stopped", async () => {
  const removed: string[] = [];
  const reported = artifact("retagged", 2 * SNAPSHOT_ORPHAN_GRACE_MS, owned);
  const removal = (listVolumeSnapshots: NonNullable<RuntimeProviderShape["listVolumeSnapshots"]>) =>
    orphanedSnapshotMethods({
      provider: {
        ...TestRuntimeProvider,
        listVolumeSnapshots,
        removeVolumeSnapshot: (ref) =>
          Effect.sync(() => {
            removed.push(ref.id);
          }),
      },
      storeIdentity: Effect.succeed("ours"),
      index: Effect.succeed([]),
    }).removeOrphanedSnapshot(reported);
  const retagged = await Effect.runPromise(
    Effect.result(
      removal(() =>
        Effect.succeed([{ ...reported, ref: { ...reported.ref, digest: "sha256:replacement" } }]),
      ),
    ),
  );
  const stopped = await Effect.runPromise(
    Effect.result(
      removal(() =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "test",
            operation: "listVolumeSnapshots",
            message: "runtime stopped",
          }),
        ),
      ),
    ),
  );
  expect([retagged._tag, stopped._tag]).toEqual(["Failure", "Failure"]);
  expect(removed).toEqual([]);
});
