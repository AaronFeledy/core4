import type { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { PathsService } from "@lando/sdk/services";
import { type Context, Effect } from "effect";
import type { AppliedStateProvider } from "./applied-state-resolution.ts";
import type { makeProviderFactory } from "./make-provider.ts";

type ProviderFactory = ReturnType<typeof makeProviderFactory>;

export const makeAppliedStateProvider = Effect.fnUntraced(function* (
  id: ProviderId,
  descriptor: Parameters<ProviderFactory>[0],
  services: {
    readonly makeProvider: ProviderFactory;
    readonly paths: Context.Service.Shape<typeof PathsService>;
  },
) {
  const { contribution, context } = descriptor;
  const resourceOwnership = contribution.resourceOwnership;
  const runtime = yield* Effect.cached(services.makeProvider(descriptor));
  return {
    id,
    ...(contribution.appliedStateInventory === undefined
      ? {}
      : {
          appliedStateInventory: contribution
            .appliedStateInventory(context)
            .pipe(Effect.provideService(PathsService, services.paths)),
        }),
    ...(resourceOwnership === undefined
      ? {}
      : {
          resourceOwnership: (root: AbsolutePath) => resourceOwnership(context, root),
        }),
    canCleanupOwnedResources: runtime.pipe(
      Effect.map((provider) => provider.cleanupOwnedResources !== undefined),
    ),
    appliedPlans: contribution
      .appliedPlans(context)
      .pipe(Effect.provideService(PathsService, services.paths)),
    isAvailable: runtime.pipe(
      Effect.flatMap((provider) =>
        provider.isAvailable.pipe(
          Effect.flatMap((available) =>
            available ? Effect.map(provider.getStatus, (status) => status.running) : Effect.succeed(false),
          ),
        ),
      ),
      Effect.catch(() => Effect.succeed(false)),
    ),
    list: (filter) => runtime.pipe(Effect.flatMap((provider) => provider.list(filter))),
    listVolumes: (filter) => runtime.pipe(Effect.flatMap((provider) => provider.listVolumes(filter))),
  } satisfies AppliedStateProvider;
});
