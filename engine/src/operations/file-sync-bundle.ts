import { sameRealpath } from "@lando/paths";
import { FileSyncStartError } from "@lando/sdk/errors";
import {
  type AppPlan,
  type AppRef,
  type FileSyncSessionSpec,
  hasStructuralFileSyncCoverage,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";
import { Effect, Result } from "effect";

export type FileSyncExecutionBundle =
  | { readonly kind: "ordinary"; readonly sessions: readonly [] }
  | { readonly kind: "accelerated"; readonly id: string; readonly sessions: readonly FileSyncSessionSpec[] };

export const normalizeFileSyncBundle = (
  plan: AppPlan,
  kind: AppRef["kind"] = "user",
): Result.Result<FileSyncExecutionBundle, FileSyncStartError> => {
  const expected = plannedFileSyncSessions(plan);
  if (expected !== undefined && expected.length === 0 && plan.fileSync.length === 0)
    return Result.succeed({ kind: "ordinary", sessions: [] });
  const first = plan.fileSync[0];
  if (
    first !== undefined &&
    first.engineId.length > 0 &&
    plan.fileSync.every(
      ({ engineId, session }) => engineId === first.engineId && session.app.kind === kind,
    ) &&
    hasStructuralFileSyncCoverage(
      {
        ...plan,
        fileSync: plan.fileSync.map(({ session }) => ({
          session: {
            ...session,
            app: { ...session.app, kind: "user" as const },
          },
        })),
      },
      { pathEquals: sameRealpath },
    )
  )
    return Result.succeed({
      kind: "accelerated",
      id: first.engineId,
      sessions: plan.fileSync.map(({ session }) => session),
    });
  return Result.fail(
    new FileSyncStartError({
      engineId: first?.engineId ?? "unknown",
      message: "The file-sync plan has mixed engines, contradictory mounts, or incomplete session coverage.",
      remediation:
        "Restore the complete recorded plan and matching sessions before retrying. No file-sync actions were performed.",
    }),
  );
};

export const fileSyncBundle = (
  plan: AppPlan,
  kind: AppRef["kind"] = "user",
): Effect.Effect<FileSyncExecutionBundle, FileSyncStartError> =>
  Result.match(normalizeFileSyncBundle(plan, kind), {
    onFailure: Effect.fail,
    onSuccess: Effect.succeed,
  });
