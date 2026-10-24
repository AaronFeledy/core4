import { makeDiagnosticTail } from "@lando/redaction";
import { DataTransferError } from "@lando/sdk/errors";
import type { ExecResult } from "@lando/sdk/services";
import { Effect } from "effect";

export const serviceCommandFailure = (
  operation: string,
  exitCode?: number,
  stderrTail?: string,
): DataTransferError =>
  new DataTransferError({
    message: `Service command ${operation} failed during data transfer.`,
    operation,
    exitCode,
    stderrTail,
    remediation: "Inspect the service command and retry after the service is healthy.",
  });

export const checkedTransferCommand = Effect.fnUntraced(function* <E, R>(
  command: Effect.Effect<ExecResult, E, R>,
  operation: string,
  env?: Readonly<Record<string, string>>,
) {
  const tail = yield* makeDiagnosticTail(env);
  const result = yield* command.pipe(Effect.mapError(() => serviceCommandFailure(operation)));
  if (result.exitCode !== 0) {
    tail.write(new TextEncoder().encode(result.stderr));
    return yield* Effect.fail(serviceCommandFailure(operation, result.exitCode, tail.finish()));
  }
  return result;
});
