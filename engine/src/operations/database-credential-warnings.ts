import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, CommandWarning } from "@lando/sdk/schema";
import { EnvironmentValueResolver, EventService, Logger } from "@lando/sdk/services";
import { Cause, DateTime, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import {
  type DatabaseCredentialCheckInput,
  type DatabaseCredentialOutcome,
  checkDatabaseCredentials,
  databaseCredentialRemediation,
} from "./database-credentials.ts";

type FailedState = "rejected" | "database-missing";

/**
 * Open the one environment session an operation shares between apply and the credential
 * check, so the check logs in with the values the containers were applied with. Undefined
 * when no service publishes a connection.
 */
export const openDatabaseCredentialSession = Effect.fnUntraced(function* (plan: AppPlan) {
  if (!Object.values(plan.services).some((service) => service.connection !== undefined)) return undefined;
  return yield* (yield* EnvironmentValueResolver).openSession();
});

const warningFor = (outcome: DatabaseCredentialOutcome, state: FailedState): CommandWarning => {
  const who = outcome.login === "root" ? "root (administrator)" : "app";
  const finding =
    state === "rejected"
      ? `it rejected the configured ${who} login`
      : `the configured database is not accessible to the ${who} login`;
  const changed = outcome.changedMembers;
  const changedFact =
    changed.length === 0
      ? ""
      : ` Since this app was last applied, these creds members changed: ${changed.map((member) => `creds.${member}`).join(", ")}. That comparison does not prove the cause.`;
  return {
    code: state === "rejected" ? "LANDO_DATABASE_CREDENTIALS_REJECTED" : "LANDO_DATABASE_MISSING",
    message: `Service ${outcome.service} is ready, but ${finding} for ${outcome.family}.${changedFact}`,
    remediation: databaseCredentialRemediation(outcome.family, state),
    context: {
      service: outcome.service,
      family: outcome.family,
      login: outcome.login,
      ...(changed.length === 0 ? {} : { changedMembers: changed.join(",") }),
    },
  };
};

/** At most one warning per service: the app login takes precedence over the root login. */
export const selectDatabaseCredentialWarnings = (
  outcomes: ReadonlyArray<DatabaseCredentialOutcome>,
): readonly CommandWarning[] => {
  const byService = new Map<string, CommandWarning>();
  for (const outcome of outcomes) {
    if (outcome.state !== "rejected" && outcome.state !== "database-missing") continue;
    if (byService.has(outcome.service) && outcome.login !== "app") continue;
    byService.set(outcome.service, warningFor(outcome, outcome.state));
  }
  return [...byService.values()];
};

export const publishDatabaseCredentialWarnings = Effect.fn("DatabaseCredentials.warn")(function* (
  input: DatabaseCredentialCheckInput,
) {
  const warnings = selectDatabaseCredentialWarnings(yield* checkDatabaseCredentials(input));
  if (warnings.length === 0) return;
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = yield* Effect.serviceOption(EventService);
  for (const warning of warnings) {
    yield* recordCommandWarning(warning);
    if (!machineOutput && Option.isSome(events)) {
      yield* events.value
        .publish(
          MessageWarnEvent.make({
            body: `${warning.message} ${warning.remediation ?? ""}`.trim(),
            timestamp: yield* DateTime.now,
          }),
        )
        .pipe(Effect.catch(() => Effect.void));
    }
  }
});

/** Diagnostics never fail a start; interruption still propagates. */
export const publishDatabaseCredentialWarningsSafely = (input: DatabaseCredentialCheckInput) =>
  publishDatabaseCredentialWarnings(input).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            const detail = Cause.pretty(cause);
            const logger = yield* Effect.serviceOption(Logger);
            if (Option.isNone(logger)) {
              yield* Effect.logWarning(`Database credential warnings could not be published: ${detail}`);
              return;
            }
            yield* logger.value
              .warn("Database credential warnings could not be published", { cause: detail })
              .pipe(Effect.catch(() => Effect.void));
          }),
    ),
  );
