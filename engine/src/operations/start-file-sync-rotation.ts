import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { EventService, FileSyncEngine, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import { hasCompleteFileSyncCoverage } from "./file-sync-plan.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";

/** Called under the app lock, before drain invalidation, hooks, or replacement intent. */
export const rotateChangedFileSync = Effect.fn("AppOperation.rotateChangedFileSync")(function* (
  target: ResolvedAppTarget,
) {
  // An interrupted replacement must resume its recorded identity, never supersede it.
  if ((yield* readPendingAcceleratedStart(target.app, target.plan)) !== null) return;
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(target.plan);
  if (provider.inspectAppliedFileSync === undefined) return;
  const prior = yield* provider.inspectAppliedFileSync(target.plan);
  if (prior.status !== "accelerated") return;
  const selected = yield* Effect.serviceOption(FileSyncEngine);
  if (Option.isNone(selected) || selected.value.id !== prior.engineId) return;
  const lifecycle = selected.value.appLifecycle;
  if (lifecycle === undefined) return;
  const phase = yield* lifecycle.disposalPhase(target.app);
  if (
    phase !== "disposing" &&
    phase !== "completed" &&
    hasCompleteFileSyncCoverage(target.plan, prior.sessions)
  )
    return;

  // Never clean targets using a desired/selected-service plan: users and ownership are old-plan data.
  const old = yield* registry.resolveAppliedPlan(target.plan.identity?.appRoot ?? target.root);
  if (
    old === undefined ||
    old.id !== target.plan.id ||
    old.provider !== target.plan.provider ||
    !sameRealpath(old.identity?.appRoot ?? old.root, target.plan.identity?.appRoot ?? target.root) ||
    !hasCompleteFileSyncCoverage(old) ||
    !hasCompleteFileSyncCoverage(old, prior.sessions) ||
    old.fileSync.some(({ engineId }) => engineId !== prior.engineId)
  )
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: prior.engineId,
        message: "The full applied file sync plan could not be verified for session rotation.",
        remediation: "Restore the original provider and applied app state, then retry `lando start`.",
      }),
    );
  const oldProvider = yield* registry.select(old);
  const oldTarget = { plan: old, app: target.app, root: old.root };
  const disposal = yield* prepareDestroyFileSync(oldTarget, oldProvider);
  const events = yield* EventService;
  const stateStore = yield* StateStore;
  const context = yield* Effect.context<Effect.Services<typeof disposal.dispose>>();
  yield* withPlanVolumeCoordination({
    plan: old,
    provider: oldProvider,
    stateStore,
    body: () =>
      Effect.gen(function* () {
        yield* events.publish(
          MessageInfoEvent.make({
            body: `File sync settings for ${old.name} changed. Lando is flushing the current sync sessions and recreating them.`,
            timestamp: DateTime.nowUnsafe(),
          }),
        );
        yield* markStartMutation(old);
        yield* disposal.quiesceRetained;
        yield* disposal.dispose;
        // The completed disposal marker survives a failure here. Retry retires state without restarting writers.
        yield* oldProvider.destroy(
          { app: old.id, plan: old },
          {
            volumes: false,
            purgeCaches: false,
            removeState: true,
          },
        );
        yield* disposal.complete;
      }).pipe(Effect.provide(context)),
  });
});
