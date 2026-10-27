import { FileSyncStopError } from "@lando/sdk/errors";
import {
  FileSyncEngine,
  type FileSyncError,
  type ProviderError,
  type RuntimeProviderShape,
  type StateStore,
} from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { pendingStartDisposal } from "./accelerated-start-disposal.ts";
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
  const retained = yield* pendingStartDisposal(app, plan);
  const inspected =
    provider.inspectAppliedFileSync === undefined
      ? {
          status:
            plan.fileSync.length > 0 && provider.prepareFileSyncTargets !== undefined
              ? ("unknown" as const)
              : ("ordinary" as const),
        }
      : yield* provider.inspectAppliedFileSync(plan);
  const retainedUnapplied = retained !== undefined && inspected.status !== "accelerated";
  const applied =
    retainedUnapplied && plan.fileSync[0] !== undefined
      ? {
          status: "accelerated" as const,
          engineId: plan.fileSync[0].engineId,
          sessions: plan.fileSync.map(({ session }) => session),
        }
      : inspected;
  const failure = (message: string) =>
    new FileSyncStopError({
      engineId: plan.fileSync[0]?.engineId ?? "unavailable",
      sessionRef: String(app.id),
      message,
      remediation: "Repair the file sync sessions and provider cleanup hooks, then retry destroy.",
    });
  const selected = yield* Effect.serviceOption(FileSyncEngine);
  const engine = Option.getOrUndefined(selected);
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
      yield* terminateFileSyncSessions(app, sessions);
      if (retained !== undefined && disposeTargets !== undefined) yield* disposeTargets(plan);
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
