import { makeDiagnosticTail } from "@lando/redaction";
import { SqlCommandFailedError } from "@lando/sdk/errors";
import type { ExecResult } from "@lando/sdk/services";
import { Effect } from "effect";

export const checkedSqlExecution = Effect.fnUntraced(function* <E, R>(
  execution: Effect.Effect<ExecResult, E, R>,
  context: {
    readonly service: string;
    readonly command: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
  },
) {
  const tail = yield* makeDiagnosticTail(context.env);
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
