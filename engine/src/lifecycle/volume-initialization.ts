import { type Context, Effect, Option } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { type ApplyResult, type RuntimeProvider, StateStore } from "@lando/sdk/services";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { withVolumeCoordinationLock } from "./volume-coordination.ts";

export const recordCreatedVolumes = (
  provider: Pick<Context.Tag.Service<typeof RuntimeProvider>, "id" | "observeVolume">,
  plan: AppPlan,
  result: ApplyResult,
) =>
  Effect.gen(function* () {
    if (!result.createdVolumes?.length) return;
    const store = yield* Effect.serviceOption(StateStore);
    const observe = provider.observeVolume;
    if (Option.isNone(store) || observe === undefined) return;
    for (const service of Object.values(plan.services)) {
      for (const mount of service.storage) {
        const fact = result.createdVolumes.find((created) => created.nativeName === mount.store);
        if (!fact || fact.ownerRoot !== plan.identity?.appRoot) continue;
        const target = { app: plan.id, service: service.name, plan };
        const observed = yield* observe(target, mount.target);
        const identity = observed.identity;
        if (
          !identity ||
          identity.origin !== "created" ||
          identity.nativeName !== fact.nativeName ||
          identity.generation !== fact.generation ||
          identity.ownerRoot !== fact.ownerRoot
        )
          continue;
        yield* withVolumeCoordinationLock(
          store.value,
          identity.coordinationKey,
          Effect.gen(function* () {
            const current = (yield* observe(target, mount.target)).identity;
            if (
              !current ||
              current.coordinationKey !== identity.coordinationKey ||
              current.generation !== identity.generation ||
              current.ownerRoot !== identity.ownerRoot ||
              current.origin !== "created"
            )
              return;
            const initialization = yield* volumeInitialization(store.value, current);
            yield* initialization.recordCreation;
          }),
        );
      }
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderInternalError({
          providerId: provider.id,
          operation: "record-volume-creation",
          message: "Could not persist verified volume creation evidence.",
          remediation: "The volume remains ineligible for seeding; inspect durable state before retrying.",
          cause,
        }),
    ),
  );
