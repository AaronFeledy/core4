import { sameRealpath } from "@lando/paths";
import { mapFailures } from "@lando/sdk/command-result";
import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, type FileSyncSessionSpec, hasStructuralFileSyncCoverage } from "@lando/sdk/schema";
import type { AppliedFileSyncInspection } from "@lando/sdk/services";
import { Effect } from "effect";
import { acquireFileSyncEngine, requireFileSyncPlanCapabilities } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { sameFileSyncSessionSpec } from "./file-sync-paths.ts";

export const hasCompleteFileSyncCoverage = (
  plan: AppPlan,
  specs: readonly FileSyncSessionSpec[] = plan.fileSync.map(({ session }) => session),
): boolean => hasStructuralFileSyncCoverage(plan, { sessions: specs, pathEquals: sameRealpath });

/**
 * Prior accelerated sessions can stay when the desired plan is the same set or a wider set
 * whose extra sessions belong to services that had no prior session. Extra mounts on a
 * service that already has a session are a settings change and must rotate.
 */
export const fileSyncPriorIsCompatibleWithDesired = (
  plan: AppPlan,
  priorSessions: readonly FileSyncSessionSpec[],
): boolean => {
  if (priorSessions.length === 0) return false;
  const desiredByKey = new Map<string, FileSyncSessionSpec>(
    plan.fileSync.map((entry) => [`${entry.session.service}/${entry.session.mountKey}`, entry.session]),
  );
  const priorKeys = new Set<string>();
  const priorServices = new Set<string>();
  for (const session of priorSessions) {
    const key = `${session.service}/${session.mountKey}`;
    if (priorKeys.has(key)) return false;
    priorKeys.add(key);
    priorServices.add(String(session.service));
    if (!sameFileSyncSessionSpec(session, desiredByKey.get(key))) return false;
  }
  return plan.fileSync.every(
    (entry) =>
      priorKeys.has(`${entry.session.service}/${entry.session.mountKey}`) ||
      !priorServices.has(String(entry.session.service)),
  );
};

export const guardOrdinaryFileSyncFallback = Effect.fnUntraced(function* (
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
) {
  if (inspectPrior === undefined) return;
  const prior = yield* inspectPrior().pipe(
    Effect.catch(() => Effect.succeed({ status: "unknown" } as const)),
  );
  if (prior.status === "missing" || prior.status === "ordinary") return;
  return yield* Effect.fail(
    new FileSyncStartError({
      engineId: "unknown",
      message:
        "The app's previous accelerated mount state must be reconciled before ordinary mounts can replace it.",
      remediation: "Restore the recorded engine and reconcile its sessions before retrying start.",
    }),
  );
});

export const preflightSelectedStartFileSync = Effect.fnUntraced(function* (plan: AppPlan, applied?: AppPlan) {
  const saved = applied?.fileSync ?? [];
  const selected = saved.filter(({ session }) => Object.hasOwn(plan.services, session.service));
  const priorEngine = saved[0]?.engineId;
  if (
    (selected.length > 0 &&
      !fileSyncPriorIsCompatibleWithDesired(
        plan,
        selected.map(({ session }) => session),
      )) ||
    (priorEngine !== undefined && plan.fileSync.some(({ engineId }) => engineId !== priorEngine))
  ) {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: priorEngine ?? "unknown",
        message: "A selected start cannot change or retire existing accelerated file-sync mounts.",
        remediation: "Run `lando start` to reconcile the app's accelerated mounts.",
      }),
    );
  }
});

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

export const resolveFileSyncMountPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  inspectPrior?: () => Effect.Effect<AppliedFileSyncInspection, unknown>,
) {
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind === "ordinary") {
    yield* guardOrdinaryFileSyncFallback(inspectPrior);
    return plan;
  }
  const engine = yield* acquireFileSyncEngine(bundle.id);
  yield* requireFileSyncPlanCapabilities(engine, plan);
  if (
    !(yield* engine.isAvailable.pipe(
      mapFailures(
        (cause) =>
          new FileSyncStartError({
            engineId: bundle.id,
            message: "Cannot determine planned file-sync engine availability.",
            remediation: "Repair the selected engine before retrying start.",
            cause,
          }),
      ),
    ))
  )
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message:
          "The planned file-sync engine is unavailable; accelerated targets cannot be populated safely.",
        remediation: "Run lando setup to repair the selected engine, then retry start.",
      }),
    );
  return plan;
});
