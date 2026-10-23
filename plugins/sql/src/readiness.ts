import { Duration, Effect } from "effect";

import { SqlCommandFailedError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { Environment } from "@lando/sdk/schema";

import type { SqlExec } from "./actions.ts";
import { resolveSqlEnvironment } from "./environment.ts";

export const waitForSqlDatabase = Effect.fn("Sql.waitForDatabase")(function* (
  exec: SqlExec,
  target: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env: Environment;
  },
) {
  const env = yield* resolveSqlEnvironment(target.env);
  return yield* runProbe(
    {
      id: `sql-ready:${target.service}`,
      policy: {
        maxAttempts: 300,
        delay: Duration.millis(100),
        backoff: "fixed",
        timeout: Duration.seconds(30),
      },
      classify: {
        success: (result) =>
          typeof result === "object" && result !== null && "ok" in result && result.ok === true
            ? "green"
            : "red",
        failure: () => "red",
      },
    },
    Effect.suspend(() => exec(target.service, target.command, env)),
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? Effect.void
        : Effect.fail(
            new SqlCommandFailedError({
              message: `Database ${target.service} did not become ready after restart.`,
              service: target.service,
              command: target.command,
              remediation: "Inspect the service logs, then retry the database operation.",
            }),
          ),
    ),
  );
});
