import { APP_LABEL } from "@lando/container-runtime/labels";
import { SnapshotGcReport, type VolumeSnapshotArtifact } from "@lando/sdk/schema";
import { DataMover, RuntimeProvider, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";

export { SnapshotGcReport as SnapshotGcReportResultSchema };

export const snapshotGc = Effect.fn("Operations.snapshotGc")(function* (
  options: { readonly prune?: boolean } = {},
) {
  const registry = yield* RuntimeProviderRegistry;
  const mover = yield* DataMover;
  const ids = yield* registry.list;
  const providers: Array<SnapshotGcReport["providers"][number]> = [];
  let removedCount = 0;
  for (const id of ids) {
    const selected = yield* Effect.result(registry.select(id));
    if (selected._tag === "Failure") {
      providers.push({
        provider: String(id),
        status: "unavailable",
        orphans: [],
        error: selected.failure.message,
      });
      continue;
    }
    const provider = selected.success;
    if (provider.capabilities.volumeSnapshot !== "native") continue;
    const running = yield* Effect.result(
      provider.isAvailable.pipe(
        Effect.flatMap((available) =>
          available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
        ),
      ),
    );
    if (running._tag === "Failure" || !running.success) {
      providers.push({
        provider: provider.id,
        status: "unavailable",
        orphans: [],
        ...(running._tag === "Failure" ? { error: running.failure.message } : {}),
      });
      continue;
    }
    // One provider's broken API must not hide the others' results, so failures stay per provider.
    let artifacts: ReadonlyArray<VolumeSnapshotArtifact> = [];
    const inspected = yield* Effect.result(
      Effect.gen(function* () {
        artifacts = yield* mover.findOrphanedSnapshots;
        if (options.prune !== true) return;
        for (const artifact of artifacts) {
          yield* mover.removeOrphanedSnapshot(artifact);
          removedCount++;
        }
      }).pipe(Effect.provideService(RuntimeProvider, provider)),
    );
    providers.push({
      provider: provider.id,
      ...(inspected._tag === "Failure"
        ? { status: "failed" as const, error: inspected.failure.message }
        : { status: "checked" as const }),
      orphans: artifacts.map(({ ref, createdAt, labels }) => ({
        id: ref.id,
        provider: ref.provider,
        sizeBytes: ref.sizeBytes,
        createdAt,
        ...(labels[APP_LABEL] === undefined ? {} : { app: labels[APP_LABEL] }),
      })),
    });
  }
  const orphans = providers.flatMap((provider) => provider.orphans);
  return {
    providers,
    totalCount: orphans.length,
    totalBytes: orphans.reduce((sum, orphan) => sum + orphan.sizeBytes, 0),
    removedCount,
    prune: options.prune === true,
  } satisfies SnapshotGcReport;
});
