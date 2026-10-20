import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { FileSyncEngine, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { type PendingStart, matchesRecordedTargets } from "./accelerated-start-record.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";
import { hasExactFileSyncSessionCoverage } from "./file-sync.ts";
import { verifyPreparedFileSyncTargets } from "./prepared-file-sync-targets.ts";

const resumeError = (record: PendingStart, message: string, cause?: unknown) =>
  new FileSyncStartError({
    engineId: record.engineId,
    message,
    remediation: `Restore attempt ${record.attemptId}'s recorded provider, engine, mount settings and owned session state, then run \`lando start\` (or restart/rebuild). Unknown resources have been left untouched.`,
    ...(cause === undefined ? {} : { cause }),
  });

export const recordedSessionInventory = Effect.fnUntraced(function* (
  app: AppRef,
  record: PendingStart,
  plan: AppPlan,
) {
  const selected = yield* Effect.serviceOption(FileSyncEngine);
  if (Option.isNone(selected) || selected.value.id !== record.engineId)
    return yield* Effect.fail(resumeError(record, "Resume requires the recorded file-sync engine."));
  const engine = selected.value;
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
        !record.sessions.some(({ name }) => name === identity) ||
        !plan.fileSync.some(({ session }) => sameFileSyncSessionSpec(session, spec))
      );
    })
  )
    return yield* Effect.fail(
      resumeError(record, "Unknown file-sync sessions exist for this app; resume is blocked."),
    );
  return { engine, sessions };
});

export const verifyPendingStartResume = Effect.fnUntraced(function* (app: AppRef, plan: AppPlan) {
  const record = yield* readPendingAcceleratedStart(app, plan);
  if (record === null) return null;
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry
    .select(plan)
    .pipe(mapFailureErrors((cause) => resumeError(record, "The recorded provider is unavailable.", cause)));
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
  const { engine, sessions } = yield* recordedSessionInventory(app, record, plan);
  const prior = yield* provider.inspectAppliedFileSync(plan);
  if (
    prior.status === "accelerated" &&
    (prior.engineId !== record.engineId ||
      (engine.appLifecycle !== undefined && !hasExactFileSyncSessionCoverage(prior.sessions, sessions)))
  )
    return yield* Effect.fail(
      resumeError(record, "Applied accelerated state has missing or changed durable sessions."),
    );
  const prepared = yield* provider.prepareFileSyncTargets(plan);
  yield* verifyPreparedFileSyncTargets(plan, prepared.targets);
  if (!matchesRecordedTargets(record, prepared.targets))
    return yield* Effect.fail(resumeError(record, "Prepared volume names differ from the journal."));
  if (engine.appLifecycle !== undefined) yield* engine.appLifecycle.invalidateDrain(app);
  return prepared.targets;
});
