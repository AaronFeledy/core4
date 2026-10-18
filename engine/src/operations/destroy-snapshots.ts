import { Effect } from "effect";

import type { DestroyAppOptions, DestroyAppResult } from "@lando/sdk/app";
import { type AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { DataMover, RuntimeProvider, RuntimeProviderRegistry } from "@lando/sdk/services";

export const purgeAppSnapshots = Effect.fn("AppOperation.purgeSnapshots")(function* (
  sourceRoot: AbsolutePath,
  options: DestroyAppOptions | undefined,
) {
  if (options?.purgeSnapshots !== true) return 0;
  const mover = yield* DataMover;
  const registry = yield* RuntimeProviderRegistry;
  let removed = 0;
  for (const info of yield* mover.listSnapshots({ sourceRoot })) {
    const remove = mover.removeSnapshot(info.id, info.store);
    const outcome = yield* (
      info.native === undefined
        ? remove
        : remove.pipe(
            Effect.provideService(
              RuntimeProvider,
              yield* registry.select(ProviderId.make(info.native.provider)),
            ),
          )
    ).pipe(
      Effect.as("removed" as const),
      // Another destroy or prune removed it after listing; it is gone, but not by this purge.
      Effect.catchTag("SnapshotNotFoundError", () => Effect.succeed("absent" as const)),
    );
    if (outcome === "removed") removed += 1;
  }
  return removed;
});

export const snapshotOnlyDestroy = Effect.fn("AppOperation.snapshotOnlyDestroy")(function* (
  app: string,
  root: AbsolutePath,
  options: DestroyAppOptions | undefined,
): Effect.fn.Return<
  DestroyAppResult,
  Effect.Error<ReturnType<typeof purgeAppSnapshots>>,
  DataMover | RuntimeProviderRegistry
> {
  const snapshotsRemoved = yield* purgeAppSnapshots(root, options);
  return {
    app,
    outcome: snapshotsRemoved > 0 ? "destroyed" : "unchanged",
    servicesDestroyed: [],
    volumesRemoved: false,
    snapshotsRemoved,
  };
});
