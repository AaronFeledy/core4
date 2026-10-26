import { Effect } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, type FileSyncSessionSpec, plannedFileSyncSessions } from "@lando/sdk/schema";
import { type AppliedFileSyncInspection, FileSyncEngine } from "@lando/sdk/services";

const hasAcceleratedMounts = (plan: AppPlan): boolean => plannedFileSyncSessions(plan)?.length !== 0;

export const hasCompleteFileSyncCoverage = (
  plan: AppPlan,
  specs: readonly FileSyncSessionSpec[] = plan.fileSync.map(({ session }) => session),
): boolean => {
  const expected = plannedFileSyncSessions(plan);
  if (expected === undefined || expected.length === 0 || specs.length !== expected.length) return false;

  const seen = new Set<(typeof expected)[number]>();
  return specs.every((session) => {
    const mount = expected.find(
      (candidate) => candidate.service === session.service && candidate.mountKey === session.mountKey,
    );
    if (mount === undefined || seen.has(mount)) return false;
    seen.add(mount);
    return (
      session.app.kind === "user" &&
      session.app.id === plan.id &&
      session.app.root === plan.root &&
      session.permissions === undefined &&
      session.source === mount.source &&
      session.mode === "two-way-safe" &&
      session.excludes.length === mount.excludes.length &&
      session.excludes.every((exclude, index) => exclude === mount.excludes[index]) &&
      session.target._tag === "volume" &&
      session.target.name === mount.volumeName &&
      session.target.path === mount.targetPath
    );
  });
};

/** A provider verdict is required before changing mounts for an app it has already accelerated. */
export const guardOrdinaryFileSyncFallback = Effect.fnUntraced(function* (
  plan: AppPlan,
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
) {
  if (inspectPrior === undefined) return;
  const prior = yield* inspectPrior().pipe(
    Effect.catch(() => Effect.succeed({ status: "unknown" } as const)),
  );
  if (prior.status === "missing" || prior.status === "ordinary") return;
  return yield* Effect.fail(
    new FileSyncStartError({
      engineId: plan.fileSync[0]?.engineId ?? "unknown",
      message:
        prior.status === "accelerated"
          ? "This app previously used accelerated mounts; ordinary mounts could hide unflushed container changes."
          : "Lando cannot verify the app's previous mount state; ordinary mounts could hide container changes.",
      remediation:
        "Restore the file-sync adapter and reconcile the existing session before retrying start. Inspect the provider's applied app state if needed.",
    }),
  );
});
/** Realize a planned accelerated mount as a host bind when no live sync adapter can populate its volume. */
export const withOrdinaryMounts = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      {
        ...service,
        mounts: service.mounts.map((mount) => {
          if (mount.type !== "bind" || mount.realization !== "accelerated") return mount;
          const { mountKey: _mountKey, ...bind } = mount;
          return { ...bind, realization: "passthrough" as const };
        }),
      },
    ]),
  ),
  fileSync: [],
});

/** Resolve mount realization before any provider action, using the selected runtime's live adapter readiness. */
export const resolveFileSyncMountPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
): Effect.fn.Return<AppPlan, FileSyncStartError> {
  if (!hasAcceleratedMounts(plan)) {
    yield* guardOrdinaryFileSyncFallback(plan, inspectPrior);
    return plan.fileSync.length === 0 ? plan : { ...plan, fileSync: [] };
  }
  const engine = yield* Effect.serviceOption(FileSyncEngine);
  if (
    engine._tag === "Some" &&
    hasCompleteFileSyncCoverage(plan) &&
    plan.fileSync.every((entry) => entry.engineId === engine.value.id) &&
    (yield* engine.value.isAvailable.pipe(Effect.catch(() => Effect.succeed(false))))
  ) {
    return plan;
  }
  yield* guardOrdinaryFileSyncFallback(plan, inspectPrior);
  return withOrdinaryMounts(plan);
});
