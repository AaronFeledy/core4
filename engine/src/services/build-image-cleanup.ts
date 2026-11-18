import type { BuiltImageCleanup } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Context, Effect } from "effect";
import { sweepBuiltArtifacts } from "./build-artifact-reclamation.ts";
import { openArtifactBuildResults } from "./build-artifact-results.ts";

const CleanupBatch = Context.Reference<
  { readonly providers: Set<string>; readonly releasedOwners: Set<string>; released: number } | undefined
>("@lando/engine/BuiltImageCleanupBatch", { defaultValue: () => undefined });

export const cleanupBuiltImages = Effect.fnUntraced(function* (input: {
  readonly providerIds: readonly string[];
  readonly released: number;
  readonly releasedOwners: readonly string[];
}): Effect.fn.Return<BuiltImageCleanup, never, Effect.Services<ReturnType<typeof sweepBuiltArtifacts>>> {
  const batch = yield* CleanupBatch;
  if (batch !== undefined) {
    for (const id of input.providerIds) batch.providers.add(id);
    for (const owner of input.releasedOwners) batch.releasedOwners.add(owner);
    batch.released += input.released;
    return { removed: 0, released: input.released, inUse: [] };
  }
  const swept =
    input.providerIds.length === 0
      ? { removed: 0, inUse: [] }
      : yield* sweepBuiltArtifacts(input.providerIds);
  return { ...swept, released: input.released };
});

export const withBuiltImageCleanupBatch = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const batch = { providers: new Set<string>(), releasedOwners: new Set<string>(), released: 0 };
  const result = yield* effect.pipe(Effect.provideService(CleanupBatch, batch));
  const swept =
    batch.providers.size === 0 ? { removed: 0, inUse: [] } : yield* sweepBuiltArtifacts(batch.providers);
  // Later releases in the batch can push earlier ones past the release cap, so count what the index
  // still holds; an unreadable index falls back to what this command released.
  const released = yield* openArtifactBuildResults(yield* StateStore).pipe(
    Effect.flatMap((bucket) => bucket.get),
    Effect.map(
      (index) =>
        index?.results.filter(
          (entry) =>
            entry.releasedAt !== undefined && batch.releasedOwners.has(`${entry.owner}\0${entry.providerId}`),
        ).length ?? 0,
    ),
    Effect.catch(() => Effect.succeed(batch.released)),
  );
  return { result, builtImages: { ...swept, released } };
});
