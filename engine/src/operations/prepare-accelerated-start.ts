import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan, AppRef } from "@lando/sdk/schema";
import { FileSyncEngine, type RuntimeProviderShape } from "@lando/sdk/services";
import type { ProgressEmitter } from "@lando/sdk/task-progress";
import { Cause, Effect, Exit, Fiber, Option, Ref } from "effect";
import { beginAcceleratedStart } from "./accelerated-start-journal.ts";
import { reseedRetainedTargets, terminateRetainedSessions } from "./accelerated-start-recovery.ts";
import { verifyPreparedFileSyncTargets } from "./prepared-file-sync-targets.ts";
import { type StartManagedScope, startFileSyncSessions } from "./start-file-sync.ts";

export const prepareAcceleratedStart = (
  builtPlan: AppPlan,
  provider: RuntimeProviderShape,
  execution: {
    readonly app: AppRef;
    readonly events: ProgressEmitter;
    readonly managed: StartManagedScope | undefined;
  },
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (builtPlan.fileSync.length === 0)
        return { pendingStart: undefined, preparedRollback: undefined, sessionLease: undefined };
      const prepare = provider.prepareFileSyncTargets;
      const engineId = builtPlan.fileSync[0]?.engineId ?? "unknown";
      if (prepare === undefined)
        return yield* Effect.fail(
          new FileSyncStartError({
            engineId,
            message: "The selected provider cannot prepare accelerated mount targets before app startup.",
            remediation:
              "Use ordinary bind mounts or select a provider with accelerated mount target support.",
          }),
        );
      const ref = execution.app;
      const pendingStart = yield* beginAcceleratedStart(builtPlan, ref);
      const preparation = yield* Effect.exit(
        restore(
          Effect.gen(function* () {
            if (pendingStart.retained !== undefined)
              yield* terminateRetainedSessions(ref, pendingStart.retained);
            return yield* prepare(builtPlan);
          }),
        ),
      );
      if (Exit.isFailure(preparation))
        return yield* Effect.failCause(yield* pendingStart.retainTargets(preparation.cause));
      const prepared = preparation.value;
      const coverage = yield* Effect.exit(verifyPreparedFileSyncTargets(builtPlan, prepared.targets));
      if (Exit.isFailure(coverage)) {
        if (prepared.rollback === undefined || pendingStart.retained !== undefined)
          return yield* Effect.failCause(yield* pendingStart.retainTargets(coverage.cause));
        const rollback = yield* Effect.exit(prepared.rollback);
        if (Exit.isFailure(rollback))
          return yield* Effect.failCause(Cause.combine(coverage.cause, rollback.cause));
        yield* pendingStart.clear;
        return yield* Effect.failCause(coverage.cause);
      }
      const selectedEngine = yield* Effect.serviceOption(FileSyncEngine);
      const bind = Option.isSome(selectedEngine) ? selectedEngine.value.bindPreparedTargets : undefined;
      const bindingExit =
        bind === undefined
          ? Exit.succeed(undefined)
          : yield* Effect.exit(
              restore(bind(builtPlan, prepared.targets)).pipe(
                Effect.flatMap((engine) =>
                  engine.boundApp.kind === ref.kind &&
                  engine.boundApp.id === ref.id &&
                  engine.boundApp.root === (builtPlan.identity?.appRoot ?? builtPlan.root)
                    ? Effect.succeed(engine)
                    : Effect.fail(
                        new FileSyncStartError({
                          engineId: engine.id,
                          message: "The file-sync engine returned a binding for another app.",
                          remediation: "Fix the engine's app binding before retrying accelerated startup.",
                        }),
                      ),
                ),
              ),
            );
      const boundEngine = Exit.isSuccess(bindingExit) ? bindingExit.value : undefined;
      const engine = boundEngine ?? (Option.isSome(selectedEngine) ? selectedEngine.value : undefined);
      const safeToRollbackTargets = yield* Ref.make(true);
      const syncExit = Exit.isFailure(bindingExit)
        ? Exit.failCause(bindingExit.cause)
        : yield* Effect.exit(
            restore(
              Effect.gen(function* () {
                if (pendingStart.retained !== undefined) {
                  if (engine === undefined)
                    return yield* Effect.fail(
                      new FileSyncStartError({
                        engineId,
                        message: "Recorded file-sync engine is unavailable.",
                        remediation: "Restore the engine and run `lando start`.",
                      }),
                    );
                  yield* reseedRetainedTargets(
                    builtPlan,
                    { record: pendingStart.retained, targets: prepared.targets },
                    engine,
                  );
                }
                return yield* startFileSyncSessions(
                  builtPlan,
                  execution.events,
                  execution.managed,
                  safeToRollbackTargets,
                  boundEngine,
                );
              }),
            ),
          );
      if (Exit.isSuccess(syncExit))
        return {
          pendingStart,
          preparedRollback: pendingStart.retained === undefined ? prepared.rollback : undefined,
          sessionLease: syncExit.value,
        };
      if (pendingStart.retained !== undefined)
        return yield* Effect.failCause(yield* pendingStart.retainTargets(syncExit.cause));
      const safe = yield* Ref.get(safeToRollbackTargets);
      const app = builtPlan.fileSync[0]?.session.app;
      // An interrupted parent cannot run this ownership probe; a bounded child can.
      const noOwnedSessions =
        safe && app !== undefined && engine !== undefined
          ? yield* Effect.forkDetach(
              restore(engine.listSessions({ app })).pipe(Effect.timeoutOption("3 seconds")),
            ).pipe(
              Effect.flatMap(Fiber.await),
              Effect.flatMap((inventoryExit) =>
                Exit.isFailure(inventoryExit)
                  ? Effect.failCause(Cause.combine(syncExit.cause, inventoryExit.cause))
                  : Effect.succeed(
                      Option.isSome(inventoryExit.value) && inventoryExit.value.value.length === 0,
                    ),
              ),
            )
          : false;
      if (!noOwnedSessions) return yield* Effect.failCause(syncExit.cause);
      if (prepared.rollback === undefined)
        return yield* Effect.failCause(yield* pendingStart.retainTargets(syncExit.cause));
      const rollback = yield* Effect.exit(prepared.rollback.pipe(Effect.andThen(pendingStart.clear)));
      if (Exit.isFailure(rollback))
        return yield* Effect.failCause(Cause.combine(syncExit.cause, rollback.cause));
      return yield* Effect.failCause(syncExit.cause);
    }),
  );
