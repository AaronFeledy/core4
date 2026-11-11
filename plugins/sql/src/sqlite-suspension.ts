import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { DateTime, Effect, Exit } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";
import { type SqlRuntimeObservation, resumeSqlRuntime } from "./runtime-observation.ts";
import type { SqlFileTarget } from "./target.ts";

export const withSuspendedSqlite = Effect.fnUntraced(function* <A, E, R>(
  deps: SqlCommandDeps,
  target: SqlFileTarget,
  body: (runtime: SqlRuntimeObservation) => Effect.Effect<A, E, R>,
) {
  const runtime = yield* deps.inspect(target.name);
  if (runtime.containerId === undefined || (runtime.running && runtime.imageIdentity === undefined))
    return yield* Effect.fail(
      new SqlRecoveryUnavailableError({
        message: `No usable service container exists for ${target.name}.`,
        service: target.name,
        reason: "An exact container identity is required to borrow mounts and suspend writers.",
        remediation: "Run lando start, then retry.",
      }),
    );
  const identity = { containerId: runtime.containerId, imageIdentity: runtime.imageIdentity ?? "" };
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      Effect.gen(function* () {
        if (runtime.running) yield* deps.suspend(target.name, identity);
        return yield* body(runtime);
      }),
    (_, exit) =>
      runtime.running
        ? resumeSqlRuntime({
            deps,
            service: target.name,
            identity,
            readiness: Effect.suspend(() => deps.waitForReady(target.name)),
          }).pipe(
            // The primary failure stays the command error, but the user still needs to
            // know the service is left stopped.
            Effect.catchCause((cause) =>
              Exit.isFailure(exit)
                ? deps
                    .publish(
                      MessageWarnEvent.make({
                        body: `Service ${target.name} did not resume after the failed SQLite operation. Run lando start to bring it back.`,
                        timestamp: DateTime.nowUnsafe(),
                      }),
                    )
                    .pipe(Effect.catch(() => Effect.logWarning(`Could not resume ${target.name}.`)))
                : Effect.failCause(cause),
            ),
          )
        : Effect.void,
  );
});
