import { mapDefectCause, mapFailures, mapStreamFailures } from "@lando/sdk/command-result";
import { classifyDatabaseClientResult } from "@lando/sdk/database-creds";
import { SqlCredentialApplyError, type SqlCredentialMember } from "@lando/sdk/errors";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import type { AdapterContext, ClientRequest, ClientResult, CredentialStep } from "./types.ts";

const maxOutputBytes = 64 * 1024;
const transientClientDiagnostic =
  /connection refused|connection timed out|connection reset by peer|(?:login|connection|server selection|query|socket) timeout expired|database system is starting up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERROR 200[23]\b|TCP Provider: Error code 0x274D\b/iu;

export const classifyAdminFailure = (
  context: AdapterContext,
  result: ClientResult,
  privilegeDenied: (result: ClientResult) => boolean,
): Effect.Effect<"rejected" | "insufficient-privilege", SqlCredentialApplyError> => {
  if (result.state === "rejected") return Effect.succeed("rejected");
  if (privilegeDenied(result)) return Effect.succeed("insufficient-privilege");
  if (result.state === "unverified" || result.exitCode !== 0) {
    return Effect.fail(
      context.failure("Could not prove an administrator login against the database client.", result.exitCode),
    );
  }
  return Effect.succeed("rejected");
};

export const step = (members: readonly SqlCredentialMember[], request: ClientRequest): CredentialStep => ({
  members,
  request,
});

export const firstTrimmedLine = (stdout: string): string =>
  stdout
    .split(/\r?\n/u)
    .find((entry) => entry.trim().length > 0)
    ?.trim() ?? "";

export const credentialClient = (options: {
  readonly provider: Pick<RuntimeProviderShape, "execStream">;
  readonly target: Parameters<RuntimeProviderShape["execStream"]>[0];
  readonly family: AdapterContext["family"];
  readonly failure: AdapterContext["failure"];
}) =>
  Effect.fnUntraced(function* (request: ClientRequest) {
    const { provider, target, family, failure } = options;
    const out = new TextDecoder();
    const err = new TextDecoder();
    let stdout = "";
    let stderr = "";
    let length = 0;
    let exitCode: number | undefined;
    const input = request.stdin;
    const stdinStream =
      input === undefined
        ? undefined
        : {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode(input);
            },
          };
    yield* provider
      .execStream(target, {
        command: request.argv,
        ...(request.env === undefined ? {} : { env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...request.env } }),
        ...(stdinStream === undefined ? {} : { stdinStream }),
      })
      .pipe(
        mapStreamFailures((error) =>
          failure(
            "The provider could not execute the database client.",
            undefined,
            error._tag === "ServiceExecError" ||
              error._tag === "ProviderInternalError" ||
              error._tag === "ProviderUnavailableError"
              ? "transient"
              : undefined,
          ),
        ),
        Stream.runForEach((chunk) => {
          if (exitCode !== undefined)
            return Effect.fail(failure("Unexpected output after the database client exited."));
          if ("exitCode" in chunk) exitCode = chunk.exitCode;
          else {
            length += chunk.chunk.byteLength;
            if (length > maxOutputBytes)
              return Effect.fail(failure("The database client exceeded its output bound."));
            if (chunk.kind === "stderr") stderr += err.decode(chunk.chunk, { stream: true });
            else stdout += out.decode(chunk.chunk, { stream: true });
          }
          return Effect.void;
        }),
        Effect.timeout("15 seconds"),
        mapFailures((cause) =>
          cause instanceof SqlCredentialApplyError
            ? cause
            : failure("The database client timed out.", undefined, "transient"),
        ),
        Effect.catchCause((cause) =>
          Effect.failCause(mapDefectCause(cause, () => "The database client failed unexpectedly.")),
        ),
        Effect.scoped,
      );
    if (exitCode === undefined)
      return yield* failure(
        "The provider did not report a database client exit status.",
        undefined,
        "transient",
      );
    stderr += err.decode();
    const state = classifyDatabaseClientResult(family, { exitCode, stderr });
    if (state === "unverified" && transientClientDiagnostic.test(stderr)) {
      return yield* failure(
        "The database client could not reach the server or timed out.",
        exitCode,
        "transient",
      );
    }
    return {
      stdout: stdout + out.decode(),
      stderr,
      exitCode,
      state,
    };
  });
