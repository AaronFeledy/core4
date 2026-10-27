import { makeDiagnosticTail } from "@lando/redaction";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import type { Environment } from "@lando/sdk/schema";
import type { ExecResult } from "@lando/sdk/services";
import { Effect } from "effect";
import { resolveSqlEnvironment } from "./environment.ts";

export const checkedSqlExecution = Effect.fnUntraced(function* <E, R>(
  execution: Effect.Effect<ExecResult, E, R>,
  context: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env?: Environment;
  },
) {
  const env = context.env === undefined ? undefined : yield* resolveSqlEnvironment(context.env);
  const tail = yield* makeDiagnosticTail(env);
  const failure = (exitCode?: number) =>
    new SqlCommandFailedError({
      message: `Database command failed in ${context.service}.`,
      service: context.service,
      command: context.command,
      exitCode,
      stderrTail: tail.finish(),
      remediation: "Inspect the service logs, then retry the import, export, or reset.",
    });
  const result = yield* execution.pipe(Effect.mapError(() => failure()));
  if (result.exitCode !== 0) {
    tail.write(new TextEncoder().encode(result.stderr));
    return yield* Effect.fail(failure(result.exitCode));
  }
  return result;
});
