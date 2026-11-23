import { sameRealpath } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, type AppRef, type ServiceName, fileSyncInvalidationRequired } from "@lando/sdk/schema";
import {
  type AppliedFileSyncInspection,
  type FileSyncEngineShape,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { Effect } from "effect";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import {
  type PendingStart,
  matchesRecordedTargets,
  recordedStartCommand,
} from "./accelerated-start-record.ts";
import { acquireFileSyncEngine, requireFileSyncProvider } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";
import { verifyPreparedFileSyncTargets } from "./prepared-file-sync-targets.ts";
import { markStartMutation } from "./start-incomplete-notice.ts";

const resumeError = (record: PendingStart, message: string, cause?: unknown) =>
  new FileSyncStartError({
    engineId: record.engineId,
    message,
    remediation: `Restore attempt ${record.attemptId}'s recorded provider, engine, mount settings and owned session state, then run \`${recordedStartCommand(record)}\`. Unknown resources have been left untouched.`,
    ...(cause === undefined ? {} : { cause }),
  });

export const recordedSessionInventory = Effect.fnUntraced(function* (
  app: AppRef,
  pending: { readonly record: PendingStart; readonly plan: AppPlan },
  options: {
    readonly prior?: AppliedFileSyncInspection | undefined;
    readonly engine?: FileSyncEngineShape;
  } = {},
) {
  const { record, plan } = pending;
  const { prior } = options;
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind !== "accelerated" || bundle.id !== record.engineId)
    return yield* Effect.fail(resumeError(record, "The recorded engine disagrees with the executable plan."));
  if (prior?.status === "accelerated" && prior.engineId !== record.engineId)
    return yield* Effect.fail(resumeError(record, "Applied and pending file-sync engines disagree."));
  const applied = prior?.status === "accelerated" ? prior.sessions : [];
  const expected = [...applied, ...bundle.sessions];
  const engine =
    options.engine ??
    (yield* acquireFileSyncEngine(record.engineId).pipe(
      mapFailures((cause) => resumeError(record, "Resume requires the recorded file-sync engine.", cause)),
    ));
  const sessions = yield* engine.listSessions({ app });
  const identities = new Set<string>();
  const refs = new Set<string>();
  if (
    sessions.some(({ ref, spec, app: observed, service, mountKey }) => {
      const identity = `${service}/${mountKey}`;
      const duplicate = identities.has(identity) || refs.has(ref);
      identities.add(identity);
      refs.add(ref);
      return (
        duplicate ||
        observed.kind !== app.kind ||
        observed.id !== app.id ||
        !sameRealpath(observed.root, app.root) ||
        service !== spec.service ||
        mountKey !== spec.mountKey ||
        spec.app.kind !== app.kind ||
        spec.app.id !== app.id ||
        !sameRealpath(spec.app.root, app.root) ||
        !expected.some((session) => sameFileSyncSessionSpec(session, spec))
      );
    })
  )
    return yield* Effect.fail(
      resumeError(record, "Unknown file-sync sessions exist for this app; resume is blocked."),
    );
  return { engine, sessions, applied, pending: bundle.sessions };
});

export const verifyPendingStartResume = Effect.fnUntraced(function* (
  app: AppRef,
  plan: AppPlan,
  services?: readonly ServiceName[],
) {
  const record = yield* readPendingAcceleratedStart(app, plan, services);
  if (record === null) return null;
  const registry = yield* RuntimeProviderRegistry;
  // A provider may report protected applied state as an `unknown` file-sync verdict; read it
  // strictly first so a record a newer Lando wrote never admits target preparation.
  yield* registry.readAppliedPlanStrict(plan);
  const provider = yield* registry
    .select(plan)
    .pipe(mapFailureErrors((cause) => resumeError(record, "The recorded provider is unavailable.", cause)));
  yield* requireFileSyncProvider(yield* fileSyncBundle(plan), provider);
  if (provider.prepareFileSyncTargets === undefined || provider.inspectAppliedFileSync === undefined)
    return yield* Effect.fail(
      resumeError(record, "The recorded provider cannot verify accelerated targets."),
    );
  const ownership =
    registry.resourceOwnership === undefined
      ? undefined
      : yield* registry
          .resourceOwnership(plan.provider, plan.root)
          .pipe(
            mapFailureErrors((cause) =>
              resumeError(record, "The provider ownership manifest cannot be verified.", cause),
            ),
          );
  if (
    ownership !== undefined &&
    (ownership.providerId !== record.providerId || !ownership.appIds.some((id) => id === app.id))
  )
    return yield* Effect.fail(
      resumeError(record, "The provider ownership manifest records foreign ownership."),
    );
  const prior = yield* provider.inspectAppliedFileSync(plan);
  const { engine, sessions, applied, pending } = yield* recordedSessionInventory(
    app,
    { record, plan },
    { prior },
  );
  if (
    engine.appLifecycle !== undefined &&
    applied.some((spec) => {
      if (sessions.some((session) => sameFileSyncSessionSpec(spec, session.spec))) return false;
      return (
        record.phase !== "apply-intent" || !pending.some((entry) => sameFileSyncSessionSpec(spec, entry))
      );
    })
  )
    return yield* Effect.fail(
      resumeError(record, "Applied accelerated state has missing or changed durable sessions."),
    );
  yield* markStartMutation(plan);
  const prepared = yield* provider.prepareFileSyncTargets(plan);
  yield* verifyPreparedFileSyncTargets(plan, prepared.targets);
  if (!matchesRecordedTargets(record, prepared.targets))
    return yield* Effect.fail(resumeError(record, "Prepared volume names differ from the journal."));
  if (engine.appLifecycle !== undefined) {
    const phase = yield* engine.appLifecycle.disposalPhase(app);
    // A new replacement journal may exist before its first session. Creation clears the completed marker.
    if (fileSyncInvalidationRequired(phase, sessions.length > 0))
      yield* engine.appLifecycle.invalidateDrain(app);
  }
  return prepared.targets;
});
