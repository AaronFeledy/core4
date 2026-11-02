import { type Context, Effect, Option } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan, VolumeCreationFact } from "@lando/sdk/schema";
import { type ApplyOptions, type RuntimeProvider, StateStore } from "@lando/sdk/services";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { withVolumeCoordinationLock } from "./volume-coordination.ts";

// A created volume that cannot be re-verified fails the apply instead of starting services on a
// generation that would stay ineligible for seeding with no visible cause.
const unverifiedCreation = (providerId: string) =>
  new ProviderInternalError({
    providerId,
    operation: "record-volume-creation",
    message: "Created volume identity could not be verified before recording its creation receipt.",
    remediation:
      "Inspect the volume before retrying; this generation remains ineligible for seeding without verified creation evidence.",
  });

export const recordCreatedVolume = Effect.fn("Lifecycle.recordCreatedVolume")(
  function* (
    provider: Pick<Context.Service.Shape<typeof RuntimeProvider>, "id" | "locateVolume">,
    plan: AppPlan,
    fact: VolumeCreationFact,
  ) {
    const store = yield* Effect.serviceOption(StateStore);
    if (Option.isNone(store) || fact.ownerRoot !== (plan.identity?.appRoot ?? plan.root)) return;
    for (const plannedStore of plan.stores) {
      if (plannedStore.name !== fact.nativeName) continue;
      const ref = { app: plan.id, store: plannedStore.name, scope: plannedStore.scope };
      const observed = yield* provider.locateVolume(ref);
      const identity = observed.identity;
      if (
        !identity ||
        identity.origin !== "created" ||
        identity.nativeName !== fact.nativeName ||
        identity.generation !== fact.generation ||
        identity.ownerRoot !== fact.ownerRoot
      )
        return yield* Effect.fail(unverifiedCreation(provider.id));
      yield* withVolumeCoordinationLock(
        store.value,
        identity.coordinationKey,
        Effect.gen(function* () {
          const current = (yield* provider.locateVolume(ref)).identity;
          if (
            !current ||
            current.coordinationKey !== identity.coordinationKey ||
            current.nativeName !== fact.nativeName ||
            current.generation !== identity.generation ||
            current.ownerRoot !== identity.ownerRoot ||
            current.origin !== "created"
          )
            return yield* Effect.fail(unverifiedCreation(provider.id));
          const initialization = yield* volumeInitialization(store.value, current);
          const recorded = yield* Effect.uninterruptible(initialization.recordCreation);
          if (!recorded) {
            return yield* Effect.fail(
              new ProviderInternalError({
                providerId: provider.id,
                operation: "record-volume-creation",
                message: "Verified volume creation receipt was rejected by concurrent initialization state.",
                remediation: "Inspect durable volume state before retrying; do not seed this generation.",
              }),
            );
          }
        }),
      );
    }
  },
  (effect, provider) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof ProviderInternalError && cause.operation === "record-volume-creation"
          ? cause
          : new ProviderInternalError({
              providerId: provider.id,
              operation: "record-volume-creation",
              message: "Could not persist verified volume creation evidence.",
              remediation:
                "The volume remains ineligible for seeding; inspect durable state before retrying.",
              cause,
            }),
      ),
    ),
);

export const volumeCreationRecorder = Effect.fn("Lifecycle.volumeCreationRecorder")(function* (
  provider: Pick<Context.Service.Shape<typeof RuntimeProvider>, "id" | "locateVolume">,
  plan: AppPlan,
) {
  const services = yield* Effect.context<never>();
  const recorder: NonNullable<ApplyOptions["onVolumeCreated"]> = (fact) =>
    recordCreatedVolume(provider, plan, fact).pipe(Effect.provide(services));
  return recorder;
});
