import { makeDiagnosticTailFactory } from "@lando/redaction";
import { DataTransferError } from "@lando/sdk/errors";
import type { ExecResult } from "@lando/sdk/services";
import { Cause, Effect } from "effect";

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

const completionEvidence = (
  error: unknown,
): { readonly exitCode: number; readonly stderrTail?: string } | undefined => {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("exitCode" in details)) return undefined;
  if (typeof details.exitCode !== "number") return undefined;
  const stderrTail =
    "stderrTail" in details && typeof details.stderrTail === "string" ? details.stderrTail : undefined;
  return stderrTail === undefined
    ? { exitCode: details.exitCode }
    : { exitCode: details.exitCode, stderrTail };
};

const taggedMessage = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error) || typeof error._tag !== "string") {
    return undefined;
  }
  return "message" in error && typeof error.message === "string" ? error.message : undefined;
};

const transferFailure = (
  operation: string,
  error: unknown,
  diagnostic: (text: string | undefined) => string | undefined,
): DataTransferError => {
  const evidence = completionEvidence(error);
  if (evidence !== undefined) {
    return serviceCommandFailure(operation, evidence.exitCode, diagnostic(evidence.stderrTail));
  }
  const message = diagnostic(taggedMessage(error));
  if (message === undefined) return serviceCommandFailure(operation);
  return new DataTransferError({
    message,
    operation,
    remediation:
      "Inspect and resolve the reported failure, including cleanup, before deciding whether to repeat the transfer; it may already have completed.",
  });
};

export const checkedTransferCommand = Effect.fnUntraced(function* <E, R>(
  command: Effect.Effect<ExecResult, E, R>,
  operation: string,
  env?: Readonly<Record<string, string>>,
) {
  const createTail = yield* makeDiagnosticTailFactory(env);
  const diagnostic = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    const tail = createTail();
    tail.write(new TextEncoder().encode(text));
    return tail.finish();
  };
  const result = yield* command.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(Cause.map(cause, (error) => transferFailure(operation, error, diagnostic))),
    ),
  );
  if (result.exitCode !== 0) {
    return yield* Effect.fail(serviceCommandFailure(operation, result.exitCode, diagnostic(result.stderr)));
  }
  return result;
});
