import { causeRemediation, mapFailures } from "@lando/sdk/command-result";
import { ScratchAppError } from "@lando/sdk/errors";
import { type AppPlan, planAppIdentity, planDataId } from "@lando/sdk/schema";
import { type RuntimeProviderShape, StateStore } from "@lando/sdk/services";
import { readVolumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Option } from "effect";
import { retireCreatedVolume } from "../lifecycle/volume-initialization.ts";
import { prepareOwnedResourceCleanupFrom } from "../operations/owned-resource-teardown.ts";

export const cleanupScratchOwnedState = Effect.fn("ScratchApp.cleanupOwnedState")(
  function* (input: {
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
    readonly keepVolumes: boolean;
  }) {
    const { plan, provider, keepVolumes } = input;
    const ownerRoot = plan.identity?.appRoot ?? plan.root;
    if (provider.cleanupOwnedResources !== undefined) {
      const cleanup = yield* prepareOwnedResourceCleanupFrom(
        [
          {
            appRoot: ownerRoot,
            ownerKey: planAppIdentity(plan).ownerKey,
            providerId: plan.provider,
            appIds: [plan.id],
          },
        ],
        ownerRoot,
        // Shared caches outlive the scratch, so only its inventory member goes.
        { volumes: !keepVolumes, releaseCaches: true },
      );
      yield* cleanup;
    }
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
  (effect) =>
    effect.pipe(
      mapFailures((cause) =>
        cause instanceof ScratchAppError
          ? cause
          : new ScratchAppError({
              operation: "destroy",
              message: "Unable to retire scratch ownership or volume initialization records.",
              cause,
              remediation:
                causeRemediation(cause) ?? "Repair the provider or volume state, then retry scratch destroy.",
            }),
      ),
    ),
);
