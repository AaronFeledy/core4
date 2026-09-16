import { Effect, Exit } from "effect";

import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import type { ServiceRuntimeIdentity } from "@lando/sdk/services";

import type { SqlExec } from "./actions.ts";
import type { SqlCreds } from "./creds.ts";
import { type SqlFamily, parseObservedVersion, versionCommand } from "./families.ts";

export type SqlRuntimeObservation = {
  readonly status: "missing" | "running" | "stopped";
  readonly running: boolean;
  readonly containerId?: string;
  readonly imageIdentity?: string;
};

export type ObservedSqlRuntime = ServiceRuntimeIdentity & { readonly running: boolean };

export type SqlRuntimeObservationDeps = {
  readonly exec: SqlExec;
  readonly resume: (service: string, identity: ServiceRuntimeIdentity) => Effect.Effect<void, unknown>;
  readonly suspend: (service: string, identity: ServiceRuntimeIdentity) => Effect.Effect<void, unknown>;
  readonly inspect: (service: string) => Effect.Effect<SqlRuntimeObservation, unknown>;
};

export const recoveryUnavailable = (service: string, reason: string, remediation: string) =>
  new SqlRecoveryUnavailableError({
    message: `Cannot prove recovery compatibility for ${service}.`,
    service,
    reason,
    remediation,
  });

export const requireRuntimeIdentity = (
  service: string,
  runtime: SqlRuntimeObservation,
): Effect.Effect<ObservedSqlRuntime, SqlRecoveryUnavailableError> =>
  runtime.status === "missing"
    ? Effect.fail(
        recoveryUnavailable(
          service,
          "The target database container does not exist.",
          "Start the intended app configuration normally, then retry after inspecting the created runtime.",
        ),
      )
    : runtime.containerId === undefined || runtime.imageIdentity === undefined
      ? Effect.fail(
          recoveryUnavailable(
            service,
            "The existing database container or immutable image identity is unknown.",
            "Create a logical export before mutating this database.",
          ),
        )
      : Effect.succeed({
          containerId: runtime.containerId,
          imageIdentity: runtime.imageIdentity,
          running: runtime.running,
        });

export const sameRuntime = (expected: ServiceRuntimeIdentity, actual: ServiceRuntimeIdentity): boolean =>
  expected.containerId === actual.containerId && expected.imageIdentity === actual.imageIdentity;

const inspectMatchingRuntime = (
  deps: SqlRuntimeObservationDeps,
  service: string,
  expected: ServiceRuntimeIdentity,
  running: boolean,
) =>
  Effect.suspend(() => deps.inspect(service)).pipe(
    Effect.flatMap((observed) => requireRuntimeIdentity(service, observed)),
    Effect.flatMap((current) =>
      sameRuntime(expected, current) && current.running === running
        ? Effect.succeed(current)
        : Effect.fail(
            recoveryUnavailable(
              service,
              "The database runtime identity changed before recovery mutation.",
              "Leave the database stopped, inspect the service container, and retry recovery.",
            ),
          ),
    ),
  );

export const verifyRuntimeState = (
  deps: SqlRuntimeObservationDeps,
  service: string,
  expected: ServiceRuntimeIdentity,
  running: boolean,
) => inspectMatchingRuntime(deps, service, expected, running).pipe(Effect.asVoid);

export const observeDatabaseVersion = (input: {
  readonly deps: SqlRuntimeObservationDeps;
  readonly service: string;
  readonly family: SqlFamily;
  readonly creds: SqlCreds;
  readonly env: Readonly<Record<string, string>>;
  readonly runtime: ObservedSqlRuntime;
}) => {
  const query = versionCommand(input.family, input.creds);
  const observe = Effect.gen(function* () {
    const result = yield* input.deps
      .exec(input.service, query, input.env)
      .pipe(
        Effect.mapError(() =>
          recoveryUnavailable(
            input.service,
            "The database family/version query could not run on the inspected runtime.",
            "Verify the configured database family and credentials, then create a logical export before recovery.",
          ),
        ),
      );
    yield* verifyRuntimeState(input.deps, input.service, input.runtime, true);
    const version = result.ok ? parseObservedVersion(input.family, result.stdout) : undefined;
    return version === undefined
      ? yield* Effect.fail(
          recoveryUnavailable(
            input.service,
            "The database family/version query failed or returned malformed or inconsistent output.",
            "Verify the configured database family and credentials, then create a logical export before recovery.",
          ),
        )
      : version;
  });
  if (input.runtime.running) return observe;
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const resumed = yield* input.deps.resume(input.service, input.runtime).pipe(Effect.exit);
      if (Exit.isFailure(resumed)) {
        yield* input.deps
          .suspend(input.service, input.runtime)
          .pipe(
            Effect.mapError(() =>
              recoveryUnavailable(
                input.service,
                "The inspected database runtime could not be safely resumed and returned to stopped.",
                "Leave the database stopped, inspect the service container, and use a logical export before recovery.",
              ),
            ),
          );
        return yield* Effect.fail(
          recoveryUnavailable(
            input.service,
            "The inspected database runtime could not be safely resumed for observation.",
            "Leave the database stopped, inspect the service container, and use a logical export before recovery.",
          ),
        );
      }
      const result = yield* restore(observe).pipe(Effect.exit);
      yield* input.deps
        .suspend(input.service, input.runtime)
        .pipe(
          Effect.mapError(() =>
            recoveryUnavailable(
              input.service,
              "The temporarily resumed database runtime could not be returned to stopped.",
              "Leave the database stopped, inspect the service container, and use a logical export before recovery.",
            ),
          ),
        );
      yield* verifyRuntimeState(input.deps, input.service, input.runtime, false);
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      return result.value;
    }),
  );
};
