import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { EventService, FileSyncEngine, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { withPlanVolumeCoordination } from "../lifecycle/volume-coordination.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { prepareDestroyFileSync } from "./destroy-file-sync.ts";
import {
  acquireFileSyncEngine,
  acquirePlannedFileSyncEngine,
  requireFileSyncProvider,
} from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { hasCompleteFileSyncCoverage } from "./file-sync-plan.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";

/** Called under the app lock, before drain invalidation, hooks, or replacement intent. */
export const rotateChangedFileSync = Effect.fn("AppOperation.rotateChangedFileSync")(function* (
  target: ResolvedAppTarget,
) {
  const desired = yield* fileSyncBundle(target.plan);
  // An interrupted replacement must resume its recorded identity, never supersede it.
  if ((yield* readPendingAcceleratedStart(target.app, target.plan)) !== null) return;
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(target.plan);
  yield* requireFileSyncProvider(desired, provider);
  if (provider.inspectAppliedFileSync === undefined) return;
  const prior = yield* provider.inspectAppliedFileSync(target.plan);
  if (prior.status !== "accelerated") return;

  // Required mode/exclusion support for the desired plan before any rotation or hooks.
  if (desired.kind === "accelerated") {
    yield* acquirePlannedFileSyncEngine(target.plan);
  }

  // Matching specs alone must not skip an engine switch; zero desired sessions always rotate.
  const desiredMatchesPrior =
    desired.kind === "accelerated" &&
    desired.id === prior.engineId &&
    hasCompleteFileSyncCoverage(target.plan, prior.sessions);

  // Drain/dispose always use the recorded applied engine, never the desired selection.
  const oldEngine = yield* acquireFileSyncEngine(prior.engineId).pipe(
    Effect.mapError(
      (cause) =>
        new FileSyncStartError({
          engineId: prior.engineId,
          message: "The saved accelerated app requires its original available file sync engine.",
          remediation: "Restore the recorded file sync engine and repair its sessions before retrying start.",
          cause,
        }),
    ),
  );
  const lifecycle = oldEngine.appLifecycle;
  const phase = lifecycle === undefined ? undefined : yield* lifecycle.disposalPhase(target.app);
  if (phase !== "disposing" && phase !== "completed" && desiredMatchesPrior) return;

  // Never clean targets using a desired/selected-service plan: users and ownership are old-plan data.
  const appRoot = target.plan.identity?.appRoot ?? target.root;
  const old = yield* registry.resolveAppliedPlan(appRoot);
  if (
    old === undefined ||
    old.id !== target.plan.id ||
    old.provider !== target.plan.provider ||
    !sameRealpath(old.identity?.appRoot ?? old.root, appRoot) ||
    !hasCompleteFileSyncCoverage(old) ||
    !hasCompleteFileSyncCoverage(old, prior.sessions)
  )
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: prior.engineId,
        message: "The full applied file sync plan could not be verified for session rotation.",
        remediation: "Restore the original provider and applied app state, then retry `lando start`.",
      }),
    );
  const oldProvider = yield* registry.select(old);
  const oldBundle = yield* fileSyncBundle(old);
  if (oldBundle.kind !== "accelerated" || oldBundle.id !== prior.engineId)
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: prior.engineId,
        message: "The applied engine identity disagrees with the full recorded plan.",
        remediation: "Restore the original applied plan before retrying rotation.",
      }),
    );
  const oldTarget = { plan: old, app: target.app, root: old.root };
  const disposal = yield* prepareDestroyFileSync(oldTarget, oldProvider).pipe(
    Effect.provideService(FileSyncEngine, oldEngine),
  );
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
            body:
              desired.kind === "ordinary"
                ? `File sync settings for ${old.name} changed. Lando is returning pending edits to your project before switching to direct mounts.`
                : `File sync settings for ${old.name} changed. Lando is flushing the current sync sessions and recreating them.`,
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
      }).pipe(Effect.provide(context), Effect.provideService(FileSyncEngine, oldEngine)),
  });
});
