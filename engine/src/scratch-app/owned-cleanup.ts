import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { ScratchAppError } from "@lando/sdk/errors";
import { type AppPlan, type ResourceOwnership, planAppIdentity, planDataId } from "@lando/sdk/schema";
import { type RuntimeProviderShape, StateStore } from "@lando/sdk/services";
import { readVolumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Option } from "effect";
import { retireCreatedVolume } from "../lifecycle/volume-initialization.ts";
import { prepareOwnedResourceCleanupFrom } from "../operations/owned-resource-teardown.ts";

const scratchCleanupError = (cause: unknown): ScratchAppError =>
  cause instanceof ScratchAppError
    ? cause
    : new ScratchAppError({
        operation: "destroy",
        message: "Unable to retire scratch ownership or volume initialization records.",
        cause,
        remediation:
          causeRemediation(cause) ?? "Repair the provider or volume state, then retry scratch destroy.",
      });

// Shared caches outlive the scratch, so only its inventory member goes.
const cleanupInventory = Effect.fnUntraced(function* (ownership: ResourceOwnership, keepVolumes: boolean) {
  const cleanup = yield* prepareOwnedResourceCleanupFrom([ownership], ownership.appRoot, {
    volumes: !keepVolumes,
    releaseCaches: true,
  });
  yield* cleanup;
});

export const cleanupScratchOwnedState = Effect.fn("ScratchApp.cleanupOwnedState")(
  function* (input: {
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
    readonly keepVolumes: boolean;
  }) {
    const { plan, provider, keepVolumes } = input;
    const ownerRoot = plan.identity?.appRoot ?? plan.root;
    if (provider.cleanupOwnedResources !== undefined)
      yield* cleanupInventory(
        {
          appRoot: ownerRoot,
          ownerKey: planAppIdentity(plan).ownerKey,
          providerId: plan.provider,
          appIds: [plan.id],
        },
        keepVolumes,
      );
    if (keepVolumes) return;
    const store = yield* Effect.serviceOption(StateStore);
    if (Option.isNone(store)) return;
    for (const plannedStore of plan.stores) {
      const locator = yield* provider
        .locateVolume({
          app: planDataId(plan),
          store: plannedStore.name,
          scope: plannedStore.scope,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      // A volume the cleanup skipped or refused keeps its receipt; only proven absence retires it.
      if (locator === undefined || locator.presence !== "absent") continue;
      const recorded = yield* readVolumeInitialization(store.value, locator.coordinationKey);
      if (recorded === null || recorded.identity.ownerRoot !== ownerRoot) continue;
      yield* retireCreatedVolume(recorded.identity);
    }
  },
  (effect) => effect.pipe(mapFailures(scratchCleanupError)),
);

/**
 * A planless teardown's only record of what a scratch still owns is its inventories; each is
 * cleaned up for that scratch id alone, even where it shares a root with another app.
 */
export const cleanupScratchInventory = Effect.fn("ScratchApp.cleanupInventory")(
  function* (input: {
    readonly id: string;
    readonly ownership: ReadonlyArray<ResourceOwnership>;
    readonly keepVolumes: boolean;
  }) {
    for (const hints of input.ownership)
      if (hints.appIds.some((appId) => appId === input.id))
        yield* cleanupInventory(
          { ...hints, appIds: hints.appIds.filter((appId) => appId === input.id) },
          input.keepVolumes,
        );
  },
  (effect) => effect.pipe(mapFailures(scratchCleanupError)),
);
