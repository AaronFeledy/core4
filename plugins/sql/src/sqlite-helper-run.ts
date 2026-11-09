import { CONTROL_STDOUT_LIMIT, captureCommandOutput } from "@lando/container-runtime/command-output";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderCapabilityError, SqlCommandFailedError, VolumeOperationError } from "@lando/sdk/errors";
import type { EphemeralRunSpec, ExecChunk } from "@lando/sdk/services";
import { Effect, Option, Schema, Stream } from "effect";
import { sqlCommandFailure } from "./checked-execution.ts";
import type { SqliteHelperContext, SqliteHelperDeps } from "./sqlite-helper.ts";
import type { SqlFileTarget } from "./target.ts";

const CompletionDetails = Schema.Struct({
  exitCode: Schema.optionalKey(Schema.Number),
  stderrTail: Schema.optionalKey(Schema.String),
});
// sqlite3 includes SQL excerpts after diagnostics; dumps can contain private data.
const diagnosticLines = (stderr: string): string =>
  stderr
    .split(/\r?\n/u)
    .filter((line) => !/^[\t ]{2,}\S|^\s*\^.*error here/u.test(line))
    .join("\n");
export const checkedSqliteHelper = Effect.fnUntraced(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  spec: EphemeralRunSpec,
) {
  let borrowedSubpath = false;
  return yield* captureCommandOutput(
    Stream.unwrap(
      deps.run(spec).pipe(
        Effect.match({
          onSuccess: (result) =>
            Stream.fromIterable<ExecChunk>([
              { kind: "stdout", chunk: new TextEncoder().encode(result.stdout) },
              { kind: "stderr", chunk: new TextEncoder().encode(diagnosticLines(result.stderr)) },
              { exitCode: result.exitCode },
            ]),
          onFailure: (cause) => {
            borrowedSubpath =
              cause instanceof ProviderCapabilityError && cause.capability === "volume-subpath";
            const details =
              cause instanceof VolumeOperationError
                ? Option.getOrUndefined(Schema.decodeUnknownOption(CompletionDetails)(cause.details))
                : undefined;
            const code = details?.exitCode;
            const tail = details?.stderrTail;
            const chunks: ExecChunk[] = [
              {
                kind: "stderr",
                chunk: new TextEncoder().encode(
                  diagnosticLines(typeof tail === "string" ? tail : String(cause)),
                ),
              },
            ];
            if (typeof code === "number") chunks.push({ exitCode: code });
            return Stream.concat(Stream.fromIterable(chunks), Stream.fail(cause));
          },
        }),
      ),
    ),
    {
      failure: (evidence) => {
        const failure = sqlCommandFailure(target.name, spec.command, evidence);
        return borrowedSubpath
          ? new SqlCommandFailedError({
              ...failure,
              message: "SQLite helpers cannot borrow mounts with volume subpaths.",
              remediation:
                "The provider cannot preserve borrowed volume subpaths; the helper was not started.",
            })
          : failure;
      },
      stdoutLimit: CONTROL_STDOUT_LIMIT,
    },
  );
});

export const runSqliteHelper = Effect.fn("Sql.runSqliteHelper")(function* (
  deps: SqliteHelperDeps,
  target: SqlFileTarget,
  context: SqliteHelperContext,
  command: ReadonlyArray<string>,
  options?: { readonly stdinStream?: AsyncIterable<Uint8Array>; readonly captureStdout?: boolean },
) {
  return yield* checkedSqliteHelper(deps, target, { ...context.spec, command, ...options }).pipe(
    mapFailures((cause) =>
      cause instanceof SqlCommandFailedError && /locked|busy/iu.test(cause.stderrTail ?? "")
        ? new SqlCommandFailedError({
            ...cause,
            message: `SQLite file ${context.dbPath} is busy.`,
            remediation: `Another process holds ${context.dbPath} open. Close that process and retry.`,
          })
        : cause,
    ),
  );
});
