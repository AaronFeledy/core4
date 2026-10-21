import { expect, test } from "bun:test";
import { DataTransferError, ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId, type VolumeSnapshotArtifact } from "@lando/sdk/schema";
import { DataMover, RuntimeProvider, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Option } from "effect";
import { snapshotGc } from "../../src/operations/snapshot-gc.ts";
import { emptySnapshots } from "./data-mover-support.ts";

const orphan: VolumeSnapshotArtifact = {
  ref: { provider: "test", id: "orphan", digest: "sha256:orphan", sizeBytes: 2048, format: "native" },
  createdAt: DateTime.makeUnsafe(0),
  labels: { "dev.lando.app": "app" },
};

test("reports providers unavailable when registry construction cannot reach their runtime", async () => {
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("offline")]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "offline",
          operation: "capabilities",
          message: "Runtime is stopped.",
        }),
      ),
  });
  const report = await Effect.runPromise(
    snapshotGc().pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(DataMover, {
        ...emptySnapshots,
        findOrphanedSnapshots: Effect.die("must not inspect offline runtime"),
      }),
    ),
  );
  expect(report.providers).toMatchObject([{ provider: "offline", status: "unavailable", orphans: [] }]);
});

test("reports a stopped native provider as unavailable without invoking data-plane or startup", async () => {
  const provider = {
    ...TestRuntimeProvider,
    getStatus: Effect.succeed({ running: false }),
    ensureReady: Effect.die("must not start"),
  };
  const mover = { ...emptySnapshots, findOrphanedSnapshots: Effect.die("must not inspect stopped runtime") };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("test")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const report = await Effect.runPromise(
    snapshotGc({ prune: true }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(DataMover, mover),
    ),
  );
  expect(report).toMatchObject({
    providers: [{ provider: "test", status: "unavailable", orphans: [] }],
    totalCount: 0,
    removedCount: 0,
  });
});

test.each([false, true])("reports orphan details and prunes only when requested (%s)", async (prune) => {
  const selected: string[] = [];
  const removed: string[] = [];
  const provider = { ...TestRuntimeProvider, ensureReady: Effect.die("must not start") };
  const mover = {
    ...emptySnapshots,
    findOrphanedSnapshots: Effect.gen(function* () {
      selected.push(
        Option.getOrElse(yield* Effect.serviceOption(RuntimeProvider), () => ({ id: "missing" })).id,
      );
      return [orphan];
    }),
    removeOrphanedSnapshot: (artifact: VolumeSnapshotArtifact) =>
      Effect.sync(() => {
        removed.push(artifact.ref.id);
      }),
  };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("test")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const report = await Effect.runPromise(
    snapshotGc({ prune }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(DataMover, mover),
    ),
  );
  expect(selected).toEqual(["test"]);
  expect(report).toMatchObject({
    totalCount: 1,
    totalBytes: 2048,
    removedCount: prune ? 1 : 0,
    providers: [
      { status: "checked", orphans: [{ id: "orphan", provider: "test", app: "app", sizeBytes: 2048 }] },
    ],
  });
  expect(removed).toEqual(prune ? ["orphan"] : []);
});

test("does not issue a successful removal report when the orphan recheck refuses deletion", async () => {
  const refusal = new DataTransferError({
    operation: "removeOrphanedSnapshot",
    message: "Snapshot became indexed.",
    remediation: "Review the current orphan report.",
  });
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("test")]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: () => Effect.succeed(TestRuntimeProvider),
  });
  const result = await Effect.runPromise(
    snapshotGc({ prune: true }).pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(DataMover, {
        ...emptySnapshots,
        findOrphanedSnapshots: Effect.succeed([orphan]),
        removeOrphanedSnapshot: () => Effect.fail(refusal),
      }),
      Effect.result,
    ),
  );
  expect(result).toMatchObject({
    _tag: "Success",
    success: {
      removedCount: 0,
      providers: [{ status: "failed", error: "Snapshot became indexed.", orphans: [{ id: "orphan" }] }],
    },
  });
});

test("reports a failing provider without hiding another provider's orphans", async () => {
  const healthy = { ...TestRuntimeProvider, id: "healthy" };
  const broken = { ...TestRuntimeProvider, id: "broken" };
  const mover = {
    ...emptySnapshots,
    findOrphanedSnapshots: Effect.gen(function* () {
      const provider = yield* Effect.serviceOption(RuntimeProvider);
      if (Option.isSome(provider) && provider.value.id === "broken")
        return yield* Effect.fail(
          new DataTransferError({
            operation: "orphanedSnapshots",
            message: "image listing failed",
            remediation: "Retry.",
          }),
        );
      return [orphan];
    }),
  };
  const registry = RuntimeProviderRegistry.of({
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("broken"), ProviderId.make("healthy")]),
    capabilities: Effect.succeed(healthy.capabilities),
    select: (target) => Effect.succeed(String(target) === "broken" ? broken : healthy),
  });
  const report = await Effect.runPromise(
    snapshotGc().pipe(
      Effect.provideService(RuntimeProviderRegistry, registry),
      Effect.provideService(DataMover, mover),
    ),
  );
  expect(report.providers).toMatchObject([
    { provider: "broken", status: "failed", error: "image listing failed", orphans: [] },
    { provider: "healthy", status: "checked", orphans: [{ id: "orphan" }] },
  ]);
  expect(report.totalCount).toBe(1);
});
