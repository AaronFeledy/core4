import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, AppRef, PreparedFileSyncTarget } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { Effect } from "effect";
import { beginOrResumeAcceleratedStart } from "./accelerated-start-journal.ts";
import { matchesRecordedTargets } from "./accelerated-start-record.ts";
import { acquirePlannedFileSyncEngine, requireFileSyncProvider } from "./file-sync-acquire.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import { verifyPreparedFileSyncTargets } from "./prepared-file-sync-targets.ts";
import { type StartManagedScope, startFileSyncSessions } from "./start-file-sync.ts";

export const prepareAcceleratedStart = Effect.fnUntraced(function* (
  plan: AppPlan,
  provider: RuntimeProviderShape,
  execution: {
    readonly app: AppRef;
    readonly events: ProgressEmitter;
    readonly managed: StartManagedScope | undefined;
    readonly preparedTargets?: readonly PreparedFileSyncTarget[];
  },
) {
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind === "ordinary") return { pendingStart: undefined };
  yield* requireFileSyncProvider(bundle, provider);
  const prepare = provider.prepareFileSyncTargets;
  const engineId = bundle.id;
  if (prepare === undefined)
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId,
        message: "The selected provider cannot prepare accelerated targets.",
        remediation: "Restore the recorded provider or use ordinary bind mounts for a new app.",
      }),
    );
  const pendingStart = yield* beginOrResumeAcceleratedStart(plan, execution.app);
  const prepared =
    execution.preparedTargets === undefined ? yield* prepare(plan) : { targets: execution.preparedTargets };
  yield* verifyPreparedFileSyncTargets(plan, prepared.targets);
  if (!matchesRecordedTargets(pendingStart.record, prepared.targets))
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId,
        message: "Prepared volume names differ from the journal.",
        remediation:
          "Restore the recorded sync target volumes and provider settings, then run `lando start`. Sessions have been left untouched.",
      }),
    );
  const selected = yield* acquirePlannedFileSyncEngine(plan);
  const bind = selected.bindPreparedTargets;
  const bound = bind === undefined ? undefined : yield* bind(plan, prepared.targets);
  if (
    bound !== undefined &&
    (bound.boundApp.kind !== execution.app.kind ||
      bound.boundApp.id !== execution.app.id ||
      bound.boundApp.root !== (plan.identity?.appRoot ?? plan.root))
  )
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId,
        message: "The file-sync engine returned a binding for another app.",
        remediation: "Fix the engine's app binding before retrying accelerated startup.",
      }),
    );
  yield* startFileSyncSessions(
    plan,
    execution.events,
    execution.managed,
    bound,
    pendingStart.resumedFrom === "apply-intent",
  );
  return { pendingStart };
});
