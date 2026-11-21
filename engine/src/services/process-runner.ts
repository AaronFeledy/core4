import { RedactionService } from "@lando/redaction/service";
import { tryPromiseSettled } from "@lando/sdk/abortable-promise";
import { identityRedactor } from "@lando/sdk/command-result";
import { FileIoError, ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { REDACTED, isSecretFieldName } from "@lando/sdk/secrets";
import {
  EventService,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamChunk,
} from "@lando/sdk/services";
import { Context, Effect, Layer, Stream } from "effect";
import {
  type CapturedHostExecutionContext,
  HostExecutionDefaults,
  captureScopedHostExecutionContext,
} from "./host-execution-context.ts";
import { PreparedProcessBinding } from "./prepared-process.ts";
import { openProcessStream, runProcess } from "./process-execution.ts";
import { prepareProcessSpawn } from "./process-spawn-context.ts";
import { type RunnerRedactionCarrier, runnerEnvRedaction } from "./runner-redaction.ts";
import { environmentForRedaction } from "./tooling-input-environment.ts";

export { withPreparedProcess } from "./prepared-process.ts";

export { awaitSinkResult } from "./process-io.ts";
export { resolveProcessCgroup } from "./process-spawn-context.ts";

export type ProcessRedactionCarrier = RunnerRedactionCarrier;

const ProcessRedactionTokens = Context.Reference<ProcessRedactionCarrier>(
  "@lando/engine/ProcessRedactionTokens",
  { defaultValue: (): ProcessRedactionCarrier => ({ substring: [] }) },
);

export const withProcessRedactionTokens = <A, E, R>(
  tokens: ProcessRedactionCarrier,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provideService(ProcessRedactionTokens, tokens));

const execError = (input: ProcessSpawnOptions, cause: unknown): ProcessExecError => {
  const native = cause instanceof FileIoError ? cause.cause : cause;
  const errno =
    typeof native === "object" && native !== null && "errno" in native && typeof native.errno === "number"
      ? native.errno
      : undefined;
  return new ProcessExecError({
    message: cause instanceof Error ? cause.message : `Failed to run ${input.cmd}`,
    cmd: input.cmd,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(errno === undefined ? {} : { errno }),
    cause: native,
    remediation:
      cause instanceof FileIoError
        ? cause.remediation
        : "Install the missing host executable or fix its path, then re-run the command.",
  });
};

export const redactorForInput = Effect.fnUntraced(function* (context: CapturedHostExecutionContext) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None") return identityRedactor;
  const carrier = yield* ProcessRedactionTokens;
  const tiers = yield* runnerEnvRedaction(carrier, context);
  return yield* redaction.value.forProfile("secrets", {
    redactionTokens: tiers.substring,
    wholeTokenValues: tiers.wholeToken,
    // Explicit carrier substring stays authoritative (shell command source, overrides).
    authoritativeTokens: carrier.substring,
  });
});

type ProcessEvent = ReturnType<typeof processEventShape> &
  Partial<ProcessResult> & {
    readonly _tag: "pre-process-exec" | "post-process-exec";
  };

export const publishRedactedProcessEvent = Effect.fnUntraced(function* (
  context: CapturedHostExecutionContext,
  event: ProcessEvent,
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  const events = yield* Effect.serviceOption(EventService);
  if (redaction._tag === "None" || events._tag === "None") return;
  const redactor = yield* redactorForInput(context);
  const secretEnv = yield* environmentForRedaction({}, event.env);
  const fields = {
    cmd: redactor.redactString(event.cmd),
    args: event.args.map((arg) => redactor.redactString(arg)),
    ...(event.cwd === undefined ? {} : { cwd: redactor.redactString(event.cwd) }),
    ...(event.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(event.env).map(([key, value]) => [
              key,
              isSecretFieldName(key) && Object.hasOwn(secretEnv, key)
                ? REDACTED
                : redactor.redactString(value),
            ]),
          ),
        }),
    ...(event.stdout === undefined ? {} : { stdout: redactor.redactString(event.stdout) }),
    ...(event.stderr === undefined ? {} : { stderr: redactor.redactString(event.stderr) }),
  };
  yield* events.value.publish({ ...event, ...fields }).pipe(Effect.ignore);
});

const processEventShape = (input: ProcessSpawnOptions) => ({
  cmd: input.cmd,
  args: [...input.args],
  ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  ...(input.env === undefined ? {} : { env: { ...input.env } }),
});

const redactProcessError = Effect.fnUntraced(function* (
  context: CapturedHostExecutionContext,
  error: ProcessExecError | ProcessTimeoutError,
  capture: boolean,
) {
  const redactor = yield* redactorForInput(context);
  const fields = {
    message: redactor.redactString(error.message),
    cmd: redactor.redactString(error.cmd),
    ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
    remediation: redactor.redactString(error.remediation),
  };
  if (error instanceof ProcessTimeoutError)
    return new ProcessTimeoutError({ ...fields, elapsedMs: error.elapsedMs });
  return new ProcessExecError({
    ...fields,
    ...(error.errno === undefined ? {} : { errno: error.errno }),
    ...(capture ? {} : { cause: redactor.redactValue(error.cause) }),
  });
});

const scopedProcessStream = (
  input: ProcessSpawnOptions,
  includeExitCode: boolean,
  execution: { readonly bunCommandEnv: boolean },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const host = yield* HostExecutionDefaults;
      const snapshot = {
        ...input,
        ...(input.inheritStdin === true && host?.stdin !== undefined
          ? { inheritStdin: false, stdinStream: host.stdin }
          : {}),
        args: [...input.args],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
      };
      const binding = yield* PreparedProcessBinding;
      const prepared = binding?.request === input ? binding : undefined;
      const captured = prepared?.context ?? (yield* captureScopedHostExecutionContext(snapshot));
      const onError = (cause: unknown) =>
        cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
          ? cause
          : execError(snapshot, cause);
      return Stream.unwrap(
        Effect.gen(function* () {
          const context =
            prepared?.spawn ??
            (yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () =>
                  prepareProcessSpawn(captured, {
                    bunCommandEnv: execution.bunCommandEnv,
                    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
                  }),
                catch: onError,
              }),
              (context) => Effect.promise(() => context[Symbol.asyncDispose]()),
            ));
          const child = yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                openProcessStream(
                  { ...snapshot, cwd: context.cwd, env: context.env },
                  captured.platform,
                  includeExitCode,
                ),
              catch: onError,
            }),
            (child) =>
              Effect.promise(child.close).pipe(Effect.interruptible, Effect.timeout(1500), Effect.orDie),
          );
          return Stream.fromAsyncIterable(child.iterable, onError);
        }),
      ).pipe(
        Stream.catch((error) =>
          Stream.fromEffect(
            redactProcessError(captured, error, snapshot.capture === true).pipe(Effect.flatMap(Effect.fail)),
          ),
        ),
      );
    }),
  );

const makeService = (bunCommandEnv: boolean): Context.Service.Shape<typeof ProcessRunner> =>
  ProcessRunner.of({
    run: Effect.fn("ProcessRunner.run")(function* (input) {
      const host = yield* HostExecutionDefaults;
      const snapshot = {
        ...input,
        ...(input.inheritStdin === true && host?.stdin !== undefined
          ? { inheritStdin: false, stdinStream: host.stdin }
          : {}),
        args: [...input.args],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
      };
      const binding = yield* PreparedProcessBinding;
      const prepared = binding?.request === input ? binding : undefined;
      const captured = prepared?.context ?? (yield* captureScopedHostExecutionContext(snapshot));
      if (prepared === undefined && snapshot.capture !== true)
        yield* publishRedactedProcessEvent(captured, {
          _tag: "pre-process-exec",
          ...processEventShape(snapshot),
        });
      const result = yield* tryPromiseSettled({
        try: (signal) =>
          runProcess(snapshot, captured, {
            signal,
            bunCommandEnv,
            ...(prepared === undefined ? {} : { prepared: prepared.spawn }),
          }),
        catch: (cause) =>
          cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
            ? cause
            : execError(snapshot, cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.flatMap(redactProcessError(captured, error, snapshot.capture === true), Effect.fail),
        ),
      );
      if (prepared === undefined && snapshot.capture !== true)
        yield* publishRedactedProcessEvent(captured, {
          _tag: "post-process-exec",
          ...processEventShape(snapshot),
          ...result,
        });
      return result;
    }),
    stream: (input) =>
      scopedProcessStream(input, false, { bunCommandEnv }).pipe(
        Stream.filter((event): event is ProcessStreamChunk => "kind" in event),
      ),
    streamWithExit: (input) => scopedProcessStream(input, true, { bunCommandEnv }),
  });

export const service = makeService(false);
export const layer = Layer.succeed(ProcessRunner, service);
export const layerWithBunCommandEnv = Layer.succeed(ProcessRunner, makeService(true));
