import { makeDiagnosticTailFactory } from "@lando/redaction";
import { commandFailureCause, mapFailureCause, mergeFailure } from "@lando/sdk/command-result";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import type { FailureRole } from "@lando/sdk/schema";
import type { ExecChunk, ProcessStreamEvent } from "@lando/sdk/services";
import { Cause, Effect, Result, Stream } from "effect";

export type CommandOutputReason = "exit" | "protocol" | "provider" | "timeout" | "stdout-limit";
export interface CommandOutputFailure {
  readonly reason: CommandOutputReason;
  readonly exitCode?: number | undefined;
  readonly stderrTail?: string | undefined;
  readonly role?: FailureRole | undefined;
}
interface CommandOutputOptions<E> {
  readonly failure: (evidence: CommandOutputFailure) => E;
  readonly authoritativeTokens?: Iterable<string> | undefined;
  readonly stdout?: "forward" | "discard";
  readonly stdoutLimit?: number;
}

/** Observe an existing stream through EOF. Payload stdout is forwarded without decoding or copying. */
export const commandOutputStream = <E, R, E2>(
  source: Stream.Stream<ExecChunk | ProcessStreamEvent, E, R>,
  options: CommandOutputOptions<E2>,
): Stream.Stream<Uint8Array, E2, Exclude<R, import("effect").Scope.Scope>> =>
  Stream.unwrap(
    Effect.map(
      makeDiagnosticTailFactory({ authoritativeTokens: options.authoritativeTokens }),
      (createTail) => {
        const tail = createTail();
        let exitCode: number | undefined;
        let terminal = false;
        let protocol = false;
        let stdoutBytes = 0;
        let overflow = false;
        const owned = new Set<E2>();
        const failure = (reason: CommandOutputReason) => {
          const error = options.failure({ reason, exitCode, stderrTail: tail.finish() });
          owned.add(error);
          return error;
        };
        const output = source.pipe(
          Stream.map((event) => {
            if ("exitCode" in event) {
              if (terminal || !Number.isFinite(event.exitCode) || !Number.isInteger(event.exitCode)) {
                protocol = true;
              } else {
                exitCode = event.exitCode;
              }
              terminal = true;
              return Result.fail(undefined);
            }
            if (terminal) {
              protocol = true;
              return Result.fail(undefined);
            }
            if (event.kind === "stderr") {
              tail.write(event.chunk);
              return Result.fail(undefined);
            }
            if (options.stdout === "discard") return Result.fail(undefined);
            if (options.stdoutLimit !== undefined) {
              if (event.chunk.length > options.stdoutLimit - stdoutBytes) {
                overflow = true;
                return Result.fail(undefined);
              }
              stdoutBytes += event.chunk.length;
            }
            return overflow ? Result.fail(undefined) : Result.succeed(event.chunk);
          }),
          Stream.filterMap((value) => value),
        );
        const completed = Stream.fromEffect(
          Effect.suspend(() => {
            const reason =
              protocol || !terminal
                ? "protocol"
                : exitCode !== 0
                  ? "exit"
                  : overflow
                    ? "stdout-limit"
                    : undefined;
            return reason === undefined ? Effect.void : Effect.fail(failure(reason));
          }),
        ).pipe(Stream.drain);
        // Close producer resources before sanitizing: finalizers may fail as annotated defects.
        return Stream.scoped(Stream.concat(output, completed)).pipe(
          Stream.catchCause((cause) => {
            let cleanupOnly = true;
            let mappedFailure = false;
            const safe = mapFailureCause(commandFailureCause(cause), (error, role) => {
              mappedFailure = true;
              if (role !== "cleanup") cleanupOnly = false;
              if (owned.has(error as E2)) return error as E2;
              return options.failure({
                reason: protocol ? "protocol" : error instanceof ProcessTimeoutError ? "timeout" : "provider",
                exitCode,
                stderrTail: tail.finish(),
                role,
              });
            });
            // An internal producer scope can fail during close before our EOF check runs.
            // Preserve the observed command failure as primary beside cleanup-only reasons.
            const completionReason = protocol
              ? "protocol"
              : terminal && exitCode !== undefined && exitCode !== 0
                ? "exit"
                : terminal && exitCode === 0 && overflow
                  ? "stdout-limit"
                  : undefined;
            const withCompletion =
              mappedFailure && cleanupOnly && !Cause.hasInterrupts(cause) && completionReason !== undefined
                ? mergeFailure(Cause.fail(failure(completionReason)), safe, "cleanup")
                : safe;
            return Stream.failCause(withCompletion);
          }),
        );
      },
    ),
  );

export const CONTROL_STDOUT_LIMIT = 64 * 1024;

/** Small control results only; overflow drains the source and fails without returning a prefix. */
export const captureCommandOutput = <E, R, E2>(
  source: Stream.Stream<ExecChunk | ProcessStreamEvent, E, R>,
  options: CommandOutputOptions<E2> & { readonly stdoutLimit?: number },
) =>
  Effect.suspend(() => {
    const limit = options.stdout === "discard" ? 0 : (options.stdoutLimit ?? CONTROL_STDOUT_LIMIT);
    const buffer = new Uint8Array(limit);
    let length = 0;
    return commandOutputStream(source, { ...options, stdoutLimit: limit }).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          buffer.set(chunk, length);
          length += chunk.length;
        }),
      ),
      Effect.asVoid,
      Effect.map(() => ({
        exitCode: 0,
        stdout: new TextDecoder().decode(buffer.subarray(0, length)),
        stderr: "",
      })),
    );
  });
