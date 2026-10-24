import { Duration, Effect } from "effect";

import { SqlCommandFailedError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";

import type { SqlExec } from "./actions.ts";
import { checkedSqlExecution } from "./checked-execution.ts";

export const waitForSqlDatabase = (
  exec: SqlExec,
  target: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  },
) =>
  runProbe(
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
          typeof result === "object" && result !== null && "exitCode" in result && result.exitCode === 0
            ? "green"
            : "red",
        failure: () => "red",
      },
    },
    Effect.suspend(() => checkedSqlExecution(exec(target.service, target.command, target.env), target)),
  ).pipe(
    Effect.flatMap((result) =>
      result.outcome === "green"
        ? Effect.void
        : result.lastError instanceof SqlCommandFailedError
          ? Effect.fail(result.lastError)
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
