import { APP_LABEL } from "@lando/container-runtime/labels";
import { SnapshotGcReport } from "@lando/sdk/schema";
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
    const provider = yield* registry
      .select(id)
      .pipe(Effect.catchTag("ProviderUnavailableError", () => Effect.succeed(undefined)));
    if (provider === undefined) {
      providers.push({ provider: String(id), status: "unavailable", orphans: [] });
      continue;
    }
    if (provider.capabilities.volumeSnapshot !== "native") continue;
    const running = yield* provider.isAvailable.pipe(
      Effect.flatMap((available) =>
        available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
      ),
      Effect.catchTag("ProviderUnavailableError", () => Effect.succeed(false)),
    );
    if (!running) {
      providers.push({ provider: provider.id, status: "unavailable", orphans: [] });
      continue;
    }
    const artifacts = yield* mover.findOrphanedSnapshots.pipe(
      Effect.provideService(RuntimeProvider, provider),
    );
    if (options.prune === true) {
      for (const artifact of artifacts) {
        yield* mover.removeOrphanedSnapshot(artifact).pipe(Effect.provideService(RuntimeProvider, provider));
        removedCount++;
      }
    }
    providers.push({
      provider: provider.id,
      status: "checked",
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
