import { Effect } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, fileSyncVolumeName, sameAppMountTarget } from "@lando/sdk/schema";
import { type AppliedFileSyncInspection, FileSyncEngine } from "@lando/sdk/services";

const hasAcceleratedMounts = (plan: AppPlan): boolean =>
  Object.values(plan.services).some(
    (service) =>
      service.appMount?.realization === "accelerated" ||
      service.mounts.some((mount) => mount.type === "bind" && mount.realization === "accelerated"),
  );

const hasCompleteFileSyncCoverage = (plan: AppPlan): boolean => {
  const expected: Array<{
    readonly service: string;
    readonly mountKey: string;
    readonly source: string;
    readonly targetPath: string;
    readonly volumeName: string;
    readonly excludes: ReadonlyArray<string>;
  }> = [];
  for (const [serviceName, service] of Object.entries(plan.services)) {
    const appMount = service.appMount;
    if (appMount?.realization === "accelerated") {
      expected.push({
        service: serviceName,
        mountKey: "app-mount",
        source: appMount.source,
        targetPath: appMount.target,
        volumeName: fileSyncVolumeName(plan.name, serviceName, "app-mount"),
        excludes: appMount.excludes,
      });
    }
    for (const [index, mount] of service.mounts.entries()) {
      if (mount.type !== "bind" || mount.realization !== "accelerated") continue;
      if (sameAppMountTarget(appMount, mount)) continue;
      if (mount.source === undefined) return false;
      const mountKey = `mount-${index}`;
      expected.push({
        service: serviceName,
        mountKey,
        source: mount.source,
        targetPath: mount.target,
        volumeName: fileSyncVolumeName(plan.name, serviceName, mountKey),
        excludes: [],
      });
    }
  }
  if (expected.length === 0 || plan.fileSync.length !== expected.length) return false;

  const seen = new Set<(typeof expected)[number]>();
  return plan.fileSync.every(({ session }) => {
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
export const guardOrdinaryFileSyncFallback = (
  plan: AppPlan,
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
) =>
  Effect.gen(function* () {
    if (inspectPrior === undefined) return;
    const prior = yield* inspectPrior().pipe(
      Effect.catchAll(() => Effect.succeed({ status: "unknown" } as const)),
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
        ...(service.appMount === undefined
          ? {}
          : { appMount: { ...service.appMount, realization: "passthrough" as const } }),
        mounts: service.mounts.map((mount) =>
          mount.type === "bind" && mount.realization === "accelerated"
            ? { ...mount, realization: "passthrough" as const }
            : mount,
        ),
      },
    ]),
  ),
  fileSync: [],
});

/** Resolve mount realization before any provider action, using the selected runtime's live adapter readiness. */
export const resolveFileSyncMountPlan = (
  plan: AppPlan,
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
): Effect.Effect<AppPlan, FileSyncStartError> =>
  Effect.gen(function* () {
    if (!hasAcceleratedMounts(plan)) {
      yield* guardOrdinaryFileSyncFallback(plan, inspectPrior);
      return plan.fileSync.length === 0 ? plan : { ...plan, fileSync: [] };
    }
    const engine = yield* Effect.serviceOption(FileSyncEngine);
    if (
      engine._tag === "Some" &&
      hasCompleteFileSyncCoverage(plan) &&
      plan.fileSync.every((entry) => entry.engineId === engine.value.id) &&
      (yield* engine.value.isAvailable.pipe(Effect.catchAll(() => Effect.succeed(false))))
    ) {
      return plan;
    }
    yield* guardOrdinaryFileSyncFallback(plan, inspectPrior);
    return withOrdinaryMounts(plan);
  });
