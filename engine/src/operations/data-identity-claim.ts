import { type AppPlan, planAppIdentity } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { withLaunchVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { recordAppDataIdentity } from "../planner/data-identity.ts";
import type { PreparedRuntimeProvider } from "../providers/prepared.ts";

/**
 * Inside withLaunchVolumeCoordination, after ownership preflight (locate/lock) and before any
 * volume-producing mutation including accelerated prep: claim the folder's data name when absent.
 * The first claim wins even when the remainder of apply fails.
 */
export const claimAppDataIdentity = Effect.fn("AppDataIdentity.claim")(function* (target: ResolvedAppTarget) {
  if (target.app.kind !== "user") return;

  const identity = planAppIdentity(target.plan);
  const name = target.plan.identity?.dataName ?? target.plan.name;
  yield* recordAppDataIdentity(identity, name);
});

/** Preserve the applied-plan seed before retirement can remove its only durable source. */
export const claimDataIdentityBeforeRetirement = Effect.fn("AppDataIdentity.claimBeforeRetirement")(
  function* (target: ResolvedAppTarget, superseded: readonly AppPlan[], provider: PreparedRuntimeProvider) {
    if (target.app.kind !== "user" || superseded.length === 0) return;
    const stateStore = yield* StateStore;
    yield* withLaunchVolumeCoordination({
      plan: target.plan,
      provider,
      stateStore,
      body: () => claimAppDataIdentity(target).pipe(Effect.provideService(StateStore, stateStore)),
    });
  },
);
