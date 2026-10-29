import { FileSyncStopError } from "@lando/sdk/errors";
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
import { pendingStartDisposal } from "./accelerated-start-disposal.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";
import { hasExactFileSyncSessionCoverage, terminateFileSyncSessions } from "./file-sync.ts";

type DestroyFileSync = {
  readonly applicable: boolean;
  readonly resumed: boolean;
  readonly quiesceRetained: Effect.Effect<void, FileSyncStopError | ProviderError>;
  readonly dispose: Effect.Effect<void, FileSyncError | ProviderError>;
  readonly complete: Effect.Effect<void, FileSyncStopError>;
};

export const prepareDestroyFileSync = Effect.fn("AppOperation.prepareDestroyFileSync")(function* (
  target: ResolvedAppTarget,
  provider: RuntimeProviderShape,
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
  const retainedUnapplied = retained !== undefined && inspected.status !== "accelerated";
  const applied =
    retainedUnapplied && bundle.kind === "accelerated"
      ? {
          status: "accelerated" as const,
          engineId: bundle.id,
          sessions: bundle.sessions,
        }
      : inspected;
  const failure = (message: string) =>
    new FileSyncStopError({
      engineId: bundle.kind === "accelerated" ? bundle.id : "unavailable",
      sessionRef: String(app.id),
      message,
      remediation: "Repair the file sync sessions and provider cleanup hooks, then retry destroy.",
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
  const resumed = phase === "disposing" || phase === "completed";
  const applicable =
    applied.status === "accelerated" &&
    (phase === "completed" || (engine !== undefined && (yield* engine.isAvailable)));
  const sessions = applicable && engine !== undefined && !resumed ? yield* engine.listSessions({ app }) : [];
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
        dispose: Effect.void,
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
  if (!retainedUnapplied && !resumed && !hasExactFileSyncSessionCoverage(applied.sessions, sessions))
    return yield* Effect.fail(coverageError());
  const quiesceRetainedWriters = Effect.gen(function* () {
    if (!retainedUnapplied || resumed || quiesceRetained === undefined) return;
    const { preparedVolumeNames } = yield* quiesceRetained(plan);
    if (
      !sessions.every(({ spec }) =>
        applied.sessions.some((planned) => sameFileSyncSessionSpec(planned, spec)),
      ) ||
      (retained?.record.phase === "apply-intent" &&
        !preparedVolumeNames.every((name) =>
          sessions.some(({ spec }) => spec.target._tag === "volume" && spec.target.name === name),
        ))
    ) {
      return yield* Effect.fail(coverageError());
    }
  });
  const dispose = Effect.gen(function* () {
    if (phase === "completed") return;
    if (!retainedUnapplied && quiesce !== undefined) yield* quiesce({ app: plan.id, plan });
    if (lifecycle !== undefined) {
      if (phase !== "disposing" && phase !== "absent") yield* lifecycle.drain(app);
      if (phase !== "absent") yield* lifecycle.dispose(app);
      if (disposeTargets !== undefined) yield* disposeTargets(plan);
      if (phase !== "absent") yield* lifecycle.completeDisposal(app);
    } else {
      if (engine === undefined) {
        return yield* Effect.fail(failure("An accelerated mount has no matching file sync engine."));
      }
      yield* terminateFileSyncSessions(app, sessions).pipe(Effect.provideService(FileSyncEngine, engine));
      if (disposeTargets !== undefined) yield* disposeTargets(plan);
    }
  });
  return {
    applicable,
    resumed,
    quiesceRetained: quiesceRetainedWriters,
    dispose,
    complete: retained?.clear ?? Effect.void,
  };
});
