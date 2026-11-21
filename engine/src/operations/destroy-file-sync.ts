import { mergeAppliedPlan } from "@lando/container-runtime/plan";
import { FileSyncStopError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type FileSyncQuiesceResult,
  type FileSyncSessionInfo,
  fileSyncDisposalCommitted,
  planFileSyncDisposal,
} from "@lando/sdk/schema";
import {
  FileSyncEngine,
  type FileSyncEngineShape,
  type FileSyncError,
  type ProviderError,
  type RuntimeProviderShape,
  type StateStore,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { acceleratedStartStopError, pendingStartDisposal } from "./accelerated-start-disposal.ts";
import { recordedStartCommand } from "./accelerated-start-record.ts";
import { recordedSessionInventory } from "./accelerated-start-resume.ts";
import { hasExactFileSyncSessionCoverage, terminateFileSyncSessions } from "./file-sync.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";

type DestroyFileSync = {
  readonly applicable: boolean;
  readonly resumed: boolean;
  readonly quiesceRetained: Effect.Effect<void, FileSyncStopError | ProviderError>;
  readonly dispose: Effect.Effect<FileSyncQuiesceResult, FileSyncError | ProviderError>;
  readonly complete: Effect.Effect<void, FileSyncStopError>;
};

export const prepareDestroyFileSync = Effect.fn("AppOperation.prepareDestroyFileSync")(function* (
  target: ResolvedAppTarget,
  provider: RuntimeProviderShape,
  savedPlan?: AppPlan,
): Effect.fn.Return<DestroyFileSync, FileSyncError | ProviderError, StateStore> {
  const { plan, app } = target;
  const bundle = yield* fileSyncBundle(plan);
  const retained = yield* pendingStartDisposal(app, plan);
  const inspected =
    provider.inspectAppliedFileSync === undefined
      ? {
          status:
            bundle.kind === "accelerated" && provider.prepareFileSyncTargets !== undefined
              ? ("unknown" as const)
              : ("ordinary" as const),
        }
      : yield* provider.inspectAppliedFileSync(plan);
  const retainedUnapplied =
    retained !== undefined &&
    (retained.record.services !== undefined ||
      inspected.status !== "accelerated" ||
      !retained.plan.fileSync.every(({ session }) =>
        inspected.sessions.some((spec) => sameFileSyncSessionSpec(spec, session)),
      ));
  const cleanupPlan = retained === undefined ? plan : mergeAppliedPlan(savedPlan, retained.plan);
  const cleanupBundle = retained === undefined ? bundle : yield* fileSyncBundle(cleanupPlan);
  const applied =
    retainedUnapplied && cleanupBundle.kind === "accelerated"
      ? {
          status: "accelerated" as const,
          engineId: cleanupBundle.id,
          sessions: cleanupBundle.sessions,
        }
      : inspected;
  const failure = (
    message: string,
    remediation = "Repair the file sync sessions and provider cleanup hooks, then retry destroy.",
  ) =>
    new FileSyncStopError({
      engineId: bundle.kind === "accelerated" ? bundle.id : "unavailable",
      sessionRef: String(app.id),
      message,
      remediation,
    });
  // Applied / journal identity: acquire the recorded engine, not the desired selection.
  const engine: FileSyncEngineShape | undefined =
    applied.status === "accelerated"
      ? yield* acquireFileSyncEngine(applied.engineId).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
          Effect.map(Option.getOrUndefined),
        )
      : undefined;
  const lifecycle = applied.status === "accelerated" ? engine?.appLifecycle : undefined;
  const phase = lifecycle === undefined ? undefined : yield* lifecycle.disposalPhase(app);
  const resumed = phase !== undefined && fileSyncDisposalCommitted(phase);
  const applicable =
    applied.status === "accelerated" &&
    (phase === "completed" || (engine !== undefined && (yield* engine.isAvailable)));
  let sessions: readonly FileSyncSessionInfo[] = [];
  if (applicable && engine !== undefined && !resumed) {
    if (retained === undefined) {
      sessions = yield* engine.listSessions({ app });
    } else {
      const inventory = yield* recordedSessionInventory(app, retained, { prior: inspected, engine }).pipe(
        mapFailureErrors((cause) => acceleratedStartStopError(app, cause)),
      );
      sessions = inventory.sessions;
    }
  }
  const quiesce = provider.quiesceForFileSync;
  const quiesceRetained = provider.quiesceRetainedFileSync;
  const disposeTargets = provider.disposeFileSyncTargets;
  switch (applied.status) {
    case "unknown":
      return yield* Effect.fail(
        failure(
          "Previous file sync state could not be verified; destroying may lose unsynchronized changes.",
        ),
      );
    case "missing":
    case "ordinary":
      return {
        applicable: false,
        resumed,
        quiesceRetained: Effect.void,
        dispose: Effect.succeed({}),
        complete: retained?.clear ?? Effect.void,
      };
    case "accelerated":
      break;
  }
  if (applied.engineId !== engine?.id || !applicable)
    return yield* Effect.fail(failure("An accelerated mount has no matching file sync engine."));
  if (retainedUnapplied && quiesceRetained === undefined)
    return yield* Effect.fail(failure("The provider cannot prove retained sync writers are stopped."));
  if (phase !== "completed" && !retainedUnapplied && quiesce === undefined)
    return yield* Effect.fail(failure("This provider cannot stop app writes before flushing file sync."));
  if (lifecycle !== undefined && phase !== "completed" && disposeTargets === undefined)
    return yield* Effect.fail(failure("The provider cannot verify sync target cleanup."));
  const coverageError = () =>
    failure(
      "An accelerated mount has no matching file sync session; destroying its volume could lose changes.",
    );
  if (
    retainedUnapplied &&
    inspected.status === "accelerated" &&
    (inspected.engineId !== applied.engineId ||
      !inspected.sessions.every((spec) =>
        applied.sessions.some((entry) => sameFileSyncSessionSpec(entry, spec)),
      ))
  )
    return yield* Effect.fail(coverageError());
  if (!retainedUnapplied && !resumed && !hasExactFileSyncSessionCoverage(applied.sessions, sessions))
    return yield* Effect.fail(coverageError());
  const quiesceRetainedWriters = Effect.gen(function* () {
    if (!retainedUnapplied || resumed || quiesceRetained === undefined) return;
    if (
      !sessions.every(({ spec }) =>
        applied.sessions.some((planned) => sameFileSyncSessionSpec(planned, spec)),
      ) ||
      (inspected.status === "accelerated" &&
        !inspected.sessions.every((spec) =>
          sessions.some((session) => sameFileSyncSessionSpec(spec, session.spec)),
        ))
    )
      return yield* Effect.fail(coverageError());
    const { preparedVolumeNames } = yield* quiesceRetained(cleanupPlan);
    if (
      retained?.record.phase === "apply-intent" &&
      !preparedVolumeNames.every((name) =>
        sessions.some(({ spec }) => spec.target._tag === "volume" && spec.target.name === name),
      )
    ) {
      // App writers may have used a target whose session is gone; only its history can recover the writes.
      return yield* Effect.fail(
        failure(
          "A prepared sync target has no session after app writers may have used it; destroying it could lose changes.",
          `Restore the session's synchronization history in the file-sync engine, run \`${recordedStartCommand(retained.record)}\` to finish the attempt, then retry destroy.`,
        ),
      );
    }
  });
  const dispose = Effect.gen(function* () {
    if (phase === "completed") return {};
    const receipt = !retainedUnapplied && quiesce !== undefined ? yield* quiesce({ app: plan.id, plan }) : {};
    if (lifecycle !== undefined && phase !== undefined) {
      // Provider target cleanup sits between disposal and the completed receipt.
      const remaining = planFileSyncDisposal(phase);
      for (const operation of remaining) {
        if (operation !== "completeDisposal") yield* lifecycle[operation](app);
      }
      if (disposeTargets !== undefined) yield* disposeTargets(cleanupPlan);
      if (remaining.includes("completeDisposal")) yield* lifecycle.completeDisposal(app);
    } else {
      if (engine === undefined) {
        return yield* Effect.fail(failure("An accelerated mount has no matching file sync engine."));
      }
      yield* terminateFileSyncSessions(app, sessions).pipe(Effect.provideService(FileSyncEngine, engine));
      if (disposeTargets !== undefined) yield* disposeTargets(cleanupPlan);
    }
    return receipt;
  });
  return {
    applicable,
    resumed,
    quiesceRetained: quiesceRetainedWriters,
    dispose,
    complete: retained?.clear ?? Effect.void,
  };
});
