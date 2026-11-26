import { failureOutcomeFromCause, mapFailures, normalizeDefect } from "@lando/sdk/command-result";
import { ScratchAppError, ServiceNotReadyError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import type { EventService, FileSystem } from "@lando/sdk/services";
import { type Cause, DateTime, Effect } from "effect";
import { compensateFailure } from "../lifecycle/failure-compensation.ts";
import { HeldAppLockKeys } from "../operations/app-mutation-lock.ts";
import type { makeScratchReaper } from "./destroy.ts";
import type { makeScratchLifecycleLock } from "./lifecycle-lock.ts";
import type { ScratchRegistry, ScratchRegistryEntry } from "./registry.ts";

interface AcquisitionRequest {
  readonly entry: ScratchRegistryEntry;
  readonly instanceRoot: AbsolutePath;
  readonly keepOnFailure: boolean;
}

interface AcquisitionServices {
  readonly registry: typeof ScratchRegistry.Service;
  readonly fileSystem: typeof FileSystem.Service;
  readonly events: typeof EventService.Service;
  readonly reap: Effect.Success<typeof makeScratchReaper>;
  readonly retainedIds: ReadonlySet<string>;
  readonly withLock: Effect.Success<typeof makeScratchLifecycleLock>;
}

export const withScratchAcquisition = <A, E, R>(
  { entry, instanceRoot, keepOnFailure }: AcquisitionRequest,
  services: AcquisitionServices,
  acquire: (recordPlan: (plan: AppPlan) => void) => Effect.Effect<A, E, R>,
) => {
  const { id } = entry;
  const target = { id, instanceRoot };
  const cleanupFailure = (cause: Cause.Cause<ScratchAppError>) =>
    new ScratchAppError({
      operation: "cleanup",
      scratchId: id,
      message: `Automatic cleanup for scratch app ${id} reported a failure.`,
      remediation: `If the scratch is still listed, run \`lando scratch:destroy ${id}\`.`,
      cause: failureOutcomeFromCause(cause, normalizeDefect).error,
    });

  return services.withLock(
    target,
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* services.registry.upsert("acquire", entry);
        let plan: AppPlan | undefined;
        const work = Effect.suspend(() =>
          acquire((validated) => {
            plan = validated;
          }),
        ).pipe(
          mapFailures((error) => {
            if (!(error instanceof ScratchAppError)) return error;
            const readiness = error.cause instanceof ServiceNotReadyError ? error.cause : undefined;
            if (readiness === undefined && !keepOnFailure) return error;
            return new ScratchAppError({
              operation: error.operation,
              message: readiness === undefined ? error.message : `${error.message} ${readiness.message}`,
              remediation:
                readiness !== undefined && !keepOnFailure
                  ? "Correct the source Landofile and retry scratch acquisition. Use --keep-on-failure to retain a failing instance for inspection."
                  : error.remediation,
              ...(keepOnFailure ? { scratchId: id } : {}),
              cause: error.cause,
            });
          }),
        );
        const reap = (reason: "acquire-failure" | "scope-close") =>
          Effect.suspend(() => services.reap({ ...target, reason, ...(plan === undefined ? {} : { plan }) }));
        const result = yield* compensateFailure(
          restore(work),
          keepOnFailure
            ? Effect.void
            : reap("acquire-failure").pipe(Effect.catchCause((cause) => Effect.fail(cleanupFailure(cause)))),
          "cleanup",
        );
        if (!entry.detached) {
          yield* Effect.addFinalizer(() =>
            services
              .withLock(
                target,
                services.registry.get(id).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                  Effect.flatMap((current) =>
                    current !== undefined
                      ? Effect.succeed(!current.detached)
                      : services.fileSystem
                          .exists(instanceRoot)
                          .pipe(Effect.catch(() => Effect.succeed(true))),
                  ),
                  Effect.flatMap((owned) =>
                    owned && !services.retainedIds.has(id) ? reap("scope-close") : Effect.void,
                  ),
                ),
              )
              .pipe(
                Effect.provideService(HeldAppLockKeys, new Set()),
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const failure = cleanupFailure(cause);
                    yield* services.events
                      .publish(
                        MessageWarnEvent.make({
                          body: `${failure.message} ${failure.remediation}`,
                          timestamp: yield* DateTime.now,
                        }),
                      )
                      .pipe(Effect.ignoreCause);
                  }),
                ),
              ),
          );
        }
        return result;
      }),
    ),
  );
};
