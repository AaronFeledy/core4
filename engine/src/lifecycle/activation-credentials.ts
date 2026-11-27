import { RedactionService } from "@lando/redaction/service";
import {
  SqlCredentialAdminAuthError,
  SqlCredentialApplyError,
  SqlCredentialTargetError,
} from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan } from "@lando/sdk/schema";
import {
  type ApplyResult,
  type EnvironmentValueResolverSession,
  EventService,
  PathsService,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { Cause, DateTime, Duration, Effect, Option, Ref, type Result } from "effect";
import { catalogDatabase } from "../operations/database-convergence/catalog.ts";
import { prepareReconciliation } from "../operations/database-convergence/reconcile.ts";
import { connectionChanged } from "../operations/database-credentials.ts";
import { observeUnmanagedCredentials, warning } from "./activation-credential-warnings.ts";

export const convergeActivationCredentials = Effect.fn("Activation.convergeCredentials")(function* (input: {
  readonly plan: AppPlan;
  readonly previousPlan?: AppPlan | undefined;
  readonly provider: RuntimeProviderShape;
  readonly applied: ApplyResult;
  readonly session: EnvironmentValueResolverSession;
}) {
  const { plan, previousPlan, provider, applied, session } = input;
  const candidates = Object.values(plan.services).flatMap((service) => {
    const outcome = applied.services?.[service.name];
    const desired = service.connection;
    if (outcome === undefined || desired === undefined) return [];
    const previous = previousPlan?.services[service.name];
    if (outcome.action === "kept" && !connectionChanged(previous, service)) return [];
    return [{ service, desired, previous: previous?.connection }];
  });
  if (candidates.length === 0) return [];
  const paths = yield* Effect.serviceOption(PathsService);
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isNone(paths) || Option.isNone(redaction)) return [];
  const seedWarningEmitted = yield* Ref.make(false);
  const onAdminSeedUnavailable = Ref.getAndSet(seedWarningEmitted, true).pipe(
    Effect.flatMap((emitted) =>
      emitted
        ? Effect.void
        : warning({
            code: "LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE",
            message:
              "Could not read or initialize the private database administrator seed. Lando will try the previous or desired administrator credentials without adopting lando_admin.",
            remediation:
              "Check ownership and permissions on db-admin/key.v1 in your Lando data directory, or restore the original seed from backup. Do not replace an existing seed.",
          }),
    ),
  );
  const needsStartupTime = (family: (typeof candidates)[number]["desired"]["family"]) =>
    family !== "postgres";
  const settled = yield* Ref.make(new Set<string>());
  const changes = yield* Ref.make(
    new Map<
      string,
      {
        service: string;
        family: (typeof candidates)[number]["desired"]["family"];
        changedMembers: readonly ("user" | "password" | "rootPassword" | "database")[];
      }
    >(),
  );
  const recovery = (service: string) =>
    plan.extensions["@lando/core/scratch"] !== undefined
      ? `Inspect the scratch database with lando scratch logs ${plan.id} before retrying the scratch launch. Do not delete its volume.`
      : plan.id === "global"
        ? `Check the database, then run lando global:restart --service ${service}.`
        : `Check the database, then run lando restart --service ${service} or preview repair with lando db:creds:apply --service ${service}.`;
  const reportFailure = (service: string, family: string, detail: string, guidance?: string) =>
    warning({
      code: "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
      message: `Could not converge database credentials for ${service}. ${detail}`,
      remediation: guidance === undefined ? recovery(service) : `${guidance} ${recovery(service)}`,
      context: { service, family },
    });
  yield* Effect.forEach(
    candidates,
    ({ service, desired, previous }) =>
      Effect.gen(function* () {
        const catalog = yield* catalogDatabase({ plan, service }).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (catalog === undefined) {
          yield* observeUnmanagedCredentials({
            plan,
            provider,
            session,
            ...(previousPlan === undefined ? {} : { previousPlan }),
            services: [{ name: service.name, state: "running" }],
          });
          return;
        }
        const prepare = prepareReconciliation({
          plan,
          provider,
          service,
          desired,
          session,
          adminSeedRoot: paths.value.roots.userDataRoot,
          onAdminSeedUnavailable,
          ...(previous?.family === desired.family ? { previous } : {}),
        });
        const last = yield* Ref.make<
          Result.Result<Effect.Success<typeof prepare>, Effect.Error<typeof prepare>> | undefined
        >(undefined);
        yield* runProbe(
          {
            id: `database-credentials:${service.name}`,
            policy: {
              maxAttempts: needsStartupTime(desired.family) ? 60 : 15,
              delay: Duration.millis(250),
              timeout: Duration.seconds(needsStartupTime(desired.family) ? 24 : 8),
            },
            classify: {
              success: () => "green",
              failure: (error) => {
                return (error instanceof SqlCredentialAdminAuthError &&
                  (error.reason === "admin-password-required" || error.reason === "rejected")) ||
                  (error instanceof SqlCredentialTargetError && error.reason === "not-running") ||
                  (error instanceof SqlCredentialApplyError &&
                    error.phase === "preflight" &&
                    error.mutation === "none" &&
                    error.retryable === true)
                  ? "red"
                  : "green";
              },
            },
          },
          Effect.result(prepare).pipe(
            Effect.tap((result) => Ref.set(last, result)),
            Effect.flatMap(Effect.fromResult),
          ),
        );
        const result = yield* Ref.get(last);
        if (result === undefined) {
          yield* reportFailure(service.name, desired.family, "The server did not become available.");
          return;
        }
        const ready = yield* Effect.fromResult(result);
        const updated = yield* ready.apply;
        if (updated.outcome !== "applied" || updated.changedMembers.length === 0) return;
        const { nativeName, generation, ownerRoot } = ready.volume;
        const fresh =
          applied.createdVolumes?.some(
            (fact) =>
              fact.nativeName === nativeName &&
              fact.generation === generation &&
              fact.ownerRoot === ownerRoot,
          ) === true;
        if (fresh) return;
        if (updated.databaseCreation !== undefined) {
          const { otherDatabases, omittedCount } = updated.databaseCreation;
          const inventory =
            otherDatabases.length === 0
              ? "No other user databases were found."
              : `Other user databases: ${otherDatabases.join(", ")}${omittedCount > 0 ? ` (at least ${omittedCount} more omitted)` : ""}.`;
          const profile = yield* redaction.value.forProfile("secrets");
          yield* warning({
            code: "LANDO_DATABASE_CREATED_ON_EXISTING_STORAGE",
            message: profile.redactString(
              `Created the empty database ${desired.creds.database} for ${service.name} on existing storage. ${inventory}`,
            ),
            remediation:
              "Set creds.database back to the previous database name to use its data, or restore a backup into the new database.",
            context: { service: service.name, family: desired.family, database: desired.creds.database },
          });
        }
        yield* Ref.update(changes, (map) =>
          new Map(map).set(service.name, {
            service: service.name,
            family: desired.family,
            changedMembers: updated.changedMembers,
          }),
        );
        const events = yield* Effect.serviceOption(EventService);
        if (Option.isSome(events))
          yield* events.value
            .publish(
              MessageInfoEvent.make({
                body: `Applied changed database credentials to \`${service.name}\`: ${updated.changedMembers.join(", ")}`,
                timestamp: yield* DateTime.now,
              }),
            )
            .pipe(Effect.catch(() => Effect.void));
      }).pipe(
        Effect.provideService(RedactionService, redaction.value),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (
            error instanceof SqlCredentialApplyError ||
            error instanceof SqlCredentialTargetError ||
            error instanceof SqlCredentialAdminAuthError
          ) {
            return redaction.value
              .forProfile("secrets")
              .pipe(
                Effect.flatMap((profile) =>
                  reportFailure(
                    service.name,
                    desired.family,
                    profile.redactString(error.message),
                    error instanceof SqlCredentialApplyError
                      ? profile.redactString(error.remediation)
                      : undefined,
                  ),
                ),
              );
          }
          return reportFailure(service.name, desired.family, "The requested changes could not be verified.");
        }),
        Effect.tap(() => Ref.update(settled, (names) => new Set(names).add(service.name))),
      ),
    { concurrency: "unbounded", discard: true },
  ).pipe(
    Effect.timeoutOption(
      Duration.seconds(candidates.some(({ desired }) => needsStartupTime(desired.family)) ? 32 : 12),
    ),
  );
  const done = yield* Ref.get(settled);
  for (const { service, desired } of candidates)
    if (!done.has(service.name)) {
      yield* reportFailure(
        service.name,
        desired.family,
        "The activation credential budget expired. Inspect the database before retrying.",
      );
    }
  const verified = yield* Ref.get(changes);
  return [...verified.values()];
});
