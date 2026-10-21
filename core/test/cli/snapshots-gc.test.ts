import { expect, test } from "bun:test";
import { makeTestDataMover } from "@lando/data-mover/testing";
import { ProviderId, SnapshotGcReport, type VolumeSnapshotArtifact } from "@lando/sdk/schema";
import { DataMover, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import {
  failOnFailedProvider,
  metaSnapshotsGcSpec,
  snapshotGcOptionsFromInput,
} from "../../src/cli/command-specs/meta/snapshots/gc";
import { orphanedSnapshotsDoctor } from "../../src/cli/commands/doctor-orphaned-snapshots";
import { renderSnapshotGcReport } from "../../src/cli/commands/snapshots-gc";

const orphan: VolumeSnapshotArtifact = {
  ref: { provider: "test", id: "orphan", digest: "sha256:orphan", sizeBytes: 1024, format: "native" },
  createdAt: DateTime.makeUnsafe(0),
  labels: {},
};
const runDoctor = (artifacts: ReadonlyArray<VolumeSnapshotArtifact>, running = true) =>
  Effect.runPromise(
    orphanedSnapshotsDoctor((text) => text).pipe(
      Effect.provideService(DataMover, {
        ...makeTestDataMover().service,
        findOrphanedSnapshots: Effect.succeed(artifacts),
      }),
      Effect.provideService(
        RuntimeProviderRegistry,
        RuntimeProviderRegistry.of({
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([ProviderId.make("test")]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () =>
            Effect.succeed({
              ...TestRuntimeProvider,
              getStatus: Effect.succeed({ running }),
              ensureReady: Effect.die("must not start"),
            }),
        }),
      ),
    ),
  );

test("GC parses --prune and stays report-only by default", () => {
  expect(snapshotGcOptionsFromInput({ flags: {} })).toEqual({ prune: false });
  expect(snapshotGcOptionsFromInput({ flags: { prune: true } })).toEqual({ prune: true });
  expect(metaSnapshotsGcSpec.aliases).toContain("snapshots:gc");
  expect(metaSnapshotsGcSpec.bootstrap).toBe("provider");
});

test("GC renders empty, report and removal results while preserving the full machine schema", () => {
  const report: SnapshotGcReport = {
    providers: [],
    totalCount: 2,
    totalBytes: 2048,
    removedCount: 0,
    prune: false,
  };
  expect(renderSnapshotGcReport(report)).toBe(
    "2 orphaned snapshots (2 KiB). Run lando snapshots:gc --prune to remove them.",
  );
  expect(renderSnapshotGcReport({ ...report, totalCount: 0, totalBytes: 0 })).toBe(
    "No orphaned snapshots found.",
  );
  expect(renderSnapshotGcReport({ ...report, prune: true, removedCount: 2 })).toBe(
    "Removed 2 orphaned snapshots (2 KiB).",
  );
  expect(metaSnapshotsGcSpec.resultSchema).toBe(SnapshotGcReport);
});

test("doctor passes when no orphaned images exist", async () => {
  expect(await runDoctor([])).toMatchObject([
    { name: "orphaned-volume-snapshots", status: "pass", context: { count: "0", size: "0 B" } },
  ]);
});

test("doctor warns with a manual prune command when orphaned images exist", async () => {
  expect(await runDoctor([orphan])).toMatchObject([
    {
      name: "orphaned-volume-snapshots",
      status: "warn",
      context: { count: "1", size: "1 KiB" },
      solutions: [{ command: "lando snapshots:gc --prune" }],
    },
  ]);
});

test("doctor passes with a note when a provider is stopped", async () => {
  const checks = await runDoctor([orphan], false);
  expect(checks).toMatchObject([{ status: "pass", context: { count: "0" } }]);
  expect(checks[0]?.context.note).toContain("test");
});

test("GC fails with a tagged error when a provider could not be checked or cleaned", async () => {
  const report: SnapshotGcReport = {
    providers: [
      { provider: "broken", status: "failed", error: "image listing failed", orphans: [] },
      { provider: "test", status: "checked", orphans: [] },
    ],
    totalCount: 0,
    totalBytes: 0,
    removedCount: 0,
    prune: true,
  };
  const result = await Effect.runPromise(Effect.result(failOnFailedProvider(report)));
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "DataTransferError", operation: "snapshotGc" },
  });
  if (result._tag === "Failure") expect(result.failure.message).toContain("broken: image listing failed");
  const healthy = { ...report, providers: [{ provider: "test", status: "checked" as const, orphans: [] }] };
  expect(await Effect.runPromise(failOnFailedProvider(healthy))).toBe(healthy);
});
