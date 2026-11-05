import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import { type AppPlan, type FileSyncSessionSpec, hasStructuralFileSyncCoverage } from "@lando/sdk/schema";
import type { AppliedFileSyncInspection } from "@lando/sdk/services";
import { Effect } from "effect";
import { acquireFileSyncEngine, requireFileSyncPlanCapabilities } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";

export const hasCompleteFileSyncCoverage = (
  plan: AppPlan,
  specs: readonly FileSyncSessionSpec[] = plan.fileSync.map(({ session }) => session),
): boolean => hasStructuralFileSyncCoverage(plan, { sessions: specs, pathEquals: sameRealpath });

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
      Effect.mapError(
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
