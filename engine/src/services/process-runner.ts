import { RedactionService } from "@lando/redaction/service";
import { identityRedactor } from "@lando/sdk/command-result";
import { FileIoError, ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { REDACTED, isSecretFieldName } from "@lando/sdk/secrets";
import {
  EventService,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
  type ProcessStreamChunk,
  type ProcessStreamEvent,
} from "@lando/sdk/services";
import { Context, Effect, Layer, Stream } from "effect";
import { type CapturedHostExecutionContext, captureHostExecutionContext } from "./host-execution-context.ts";
import { PreparedProcessBinding } from "./prepared-process.ts";
import { runProcess, streamProcess } from "./process-execution.ts";
import { environmentForRedaction } from "./tooling-input-environment.ts";
export { withPreparedProcess } from "./prepared-process.ts";

export { awaitSinkResult } from "./process-io.ts";
export { resolveProcessCgroup } from "./process-spawn-context.ts";

const ProcessRedactionTokens = Context.Reference<readonly string[]>("@lando/engine/ProcessRedactionTokens", {
  defaultValue: () => [],
});

export const withProcessRedactionTokens = <A, E, R>(
  tokens: readonly string[],
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

const redactorForInput = Effect.fnUntraced(function* (context: CapturedHostExecutionContext) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None") return identityRedactor;
  return yield* redaction.value.forProfile("secrets", {
    sourceEnv: yield* environmentForRedaction(context.env, context.explicitEnv),
    authoritativeTokens: yield* ProcessRedactionTokens,
  });
});

type ProcessEvent = ReturnType<typeof processEventShape> &
  Partial<ProcessResult> & {
    readonly _tag: "pre-process-exec" | "post-process-exec";
  };

const publishRedactedProcessEvent = Effect.fnUntraced(function* (
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
      const snapshot = {
        ...input,
        args: [...input.args],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
      };
      const binding = yield* PreparedProcessBinding;
      const prepared = binding?.request === input ? binding : undefined;
      const captured = prepared?.context ?? captureHostExecutionContext(snapshot);
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const signal =
        input.signal === undefined ? controller.signal : AbortSignal.any([input.signal, controller.signal]);
      const iterator = streamProcess({ ...snapshot, signal }, captured, {
        includeExitCode,
        bunCommandEnv: execution.bunCommandEnv,
        ...(prepared === undefined ? {} : { prepared: prepared.spawn }),
      });
      const iterable: AsyncIterable<ProcessStreamEvent> = {
        [Symbol.asyncIterator]: () => ({
          next: () => iterator.next(),
          return: () => {
            controller.abort();
            return iterator.return(undefined);
          },
        }),
      };
      return Stream.fromAsyncIterable(iterable, (cause) =>
        cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
          ? cause
          : execError(snapshot, cause),
      ).pipe(
        Stream.catch((error) =>
          Stream.fromEffect(
            redactProcessError(captured, error, snapshot.capture === true).pipe(Effect.flatMap(Effect.fail)),
          ),
        ),
      );
    }),
  );

const service = (bunCommandEnv: boolean): Context.Service.Shape<typeof ProcessRunner> =>
  ProcessRunner.of({
    run: Effect.fn("ProcessRunner.run")(function* (input) {
      const snapshot = {
        ...input,
        args: [...input.args],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
      };
      const binding = yield* PreparedProcessBinding;
      const prepared = binding?.request === input ? binding : undefined;
      const captured = prepared?.context ?? captureHostExecutionContext(snapshot);
      if (prepared === undefined && snapshot.capture !== true)
        yield* publishRedactedProcessEvent(captured, {
          _tag: "pre-process-exec",
          ...processEventShape(snapshot),
        });
      let running: Promise<ProcessResult> | undefined;
      const result = yield* Effect.tryPromise({
        try: (signal) => {
          running = runProcess(snapshot, captured, {
            signal,
            bunCommandEnv,
            ...(prepared === undefined ? {} : { prepared: prepared.spawn }),
          });
          return running;
        },
        catch: (cause) =>
          cause instanceof ProcessTimeoutError || cause instanceof ProcessExecError
            ? cause
            : execError(snapshot, cause),
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.promise(async () => {
            if (running !== undefined) await Promise.allSettled([running]);
          }),
        ),
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

export const layer = Layer.succeed(ProcessRunner, service(false));
export const layerWithBunCommandEnv = Layer.succeed(ProcessRunner, service(true));
