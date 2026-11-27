import { MessageWarnEvent } from "@lando/sdk/events";
import { runProbeDetailed } from "@lando/sdk/probe";
import type { CommandWarning } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Duration, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import {
  type DatabaseCredentialCheckInput,
  checkDatabaseCredentials,
} from "../operations/database-credentials.ts";

export const warning = Effect.fnUntraced(function* (notice: CommandWarning) {
  yield* recordCommandWarning(notice);
  const machine = yield* commandWarningsUseMachineOutput;
  const events = yield* Effect.serviceOption(EventService);
  if (!machine && Option.isSome(events)) {
    yield* events.value
      .publish(
        MessageWarnEvent.make({
          body: `${notice.message} ${notice.remediation}`,
          timestamp: yield* DateTime.now,
        }),
      )
      .pipe(Effect.catch(() => Effect.void));
  }
});

export const observeUnmanagedCredentials = Effect.fn("Activation.observeUnmanagedCredentials")(function* (
  input: DatabaseCredentialCheckInput,
) {
  const { last } = yield* runProbeDetailed(
    {
      id: "unmanaged-database-credentials",
      policy: { maxAttempts: 10, delay: Duration.millis(250), timeout: Duration.seconds(8) },
      classify: (outcomes) =>
        outcomes.length > 0 && outcomes.every(({ state }) => state === "unverified") ? "red" : "green",
    },
    checkDatabaseCredentials(input),
  );
  const finding = last?.value.find(({ state }) => state === "rejected" || state === "database-missing");
  if (finding === undefined) return;
  const { service, family, login, state, changedMembers } = finding;
  yield* warning({
    code: state === "rejected" ? "LANDO_DATABASE_CREDENTIALS_REJECTED" : "LANDO_DATABASE_MISSING",
    message:
      state === "rejected"
        ? `Service ${service} rejected the configured ${login} login for ${family}.`
        : `The configured database for ${service} is not accessible to the ${login} login for ${family}.`,
    remediation: `${
      state === "rejected"
        ? "Restore the previous creds or update the database account in your image."
        : "Restore the previous database name or make the configured database accessible in your image."
    } lando db:creds:apply does not manage custom images or launchers.`,
    context: {
      service,
      family,
      login,
      ...(changedMembers.length === 0 ? {} : { changedMembers: changedMembers.join(",") }),
    },
  });
});
