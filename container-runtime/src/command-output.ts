import { makeDiagnosticTailFactory } from "@lando/redaction";
import {
  annotateFailureRole,
  commandFailureCause,
  failureDefectCause,
  mapFailureCause,
  mergeFailure,
} from "@lando/sdk/command-result";
import { ProcessTimeoutError } from "@lando/sdk/errors";
import type { FailureRole } from "@lando/sdk/schema";
import type { ExecChunk, ProcessStreamEvent } from "@lando/sdk/services";
import { Cause, Effect, Exit, Pull, Result, Scope, Stream } from "effect";

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
        const makeFailure = (evidence: CommandOutputFailure) => {
          const error = options.failure(evidence);
          owned.add(error);
          return error;
        };
        const failure = (reason: CommandOutputReason) =>
          makeFailure({ reason, exitCode, stderrTail: tail.finish() });
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
        const sanitize = (cause: Cause.Cause<unknown>, includeCompletion = true): Cause.Cause<E2> => {
          let cleanupOnly = true;
          let mappedFailure = false;
          const safe = mapFailureCause(commandFailureCause(cause), (error, role) => {
            mappedFailure = true;
            if (role !== "cleanup") cleanupOnly = false;
            if (owned.has(error as E2)) return error as E2;
            return makeFailure({
              reason: protocol ? "protocol" : error instanceof ProcessTimeoutError ? "timeout" : "provider",
              exitCode,
              stderrTail: tail.finish(),
              role,
            });
          });
          // A producer's inner scope can fail before the completion check runs.
          const completionReason = protocol
            ? "protocol"
            : terminal && exitCode !== undefined && exitCode !== 0
              ? "exit"
              : terminal && exitCode === 0 && overflow
                ? "stdout-limit"
                : undefined;
          return includeCompletion &&
            mappedFailure &&
            cleanupOnly &&
            !Cause.hasInterrupts(cause) &&
            completionReason !== undefined
            ? mergeFailure(Cause.fail(failure(completionReason)), safe, "cleanup")
            : safe;
        };
        const observed = Stream.scoped(Stream.concat(output, completed)).pipe(
          Stream.catchCause((cause) => Stream.failCause(sanitize(cause))),
        );
        // Own producer finalizers in a detached scope. Downstream early completion and
        // interruption close it through this release callback, inside the sanitizer.
        return Stream.scoped(
          Stream.fromPull(
            Effect.gen(function* () {
              const scope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
                Scope.close(scope, exit).pipe(
                  Effect.catchCause((cause) =>
                    Effect.failCause(
                      failureDefectCause(sanitize(annotateFailureRole(cause, "cleanup"), false)),
                    ),
                  ),
                ),
              );
              const pull = yield* Stream.toPull(observed).pipe(Scope.provide(scope));
              return pull.pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    // Done can coexist with a failure; strip it only after inspecting the whole cause.
                    const producer = Pull.doneExitFromCause(cause);
                    const closed = yield* Effect.exit(Scope.close(scope, producer));
                    if (Exit.isFailure(producer)) {
                      return yield* Effect.failCause(
                        sanitize(
                          Exit.isFailure(closed)
                            ? mergeFailure(producer.cause, closed.cause, "cleanup")
                            : producer.cause,
                          false,
                        ),
                      );
                    }
                    if (Exit.isFailure(closed)) {
                      return yield* Effect.failCause(
                        sanitize(annotateFailureRole(closed.cause, "cleanup"), false),
                      );
                    }
                    return yield* Effect.failCause(cause);
                  }),
                ),
              );
            }),
          ),
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
