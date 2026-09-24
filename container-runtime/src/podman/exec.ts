import { Clock, Duration, Effect, Ref, type Scope, Stream } from "effect";

import {
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  ServiceNotFoundError,
} from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk, ExecResult, ExecTarget, ProviderError } from "@lando/sdk/services";

import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import { makeAttachDecoder as makeRuntimeAttachDecoder } from "../streams.ts";

const textDecoder = new TextDecoder();

type ExecError = ProviderUnavailableError | ProviderInternalError | ServiceExecError | ServiceNotFoundError;

interface ExecCreateResponse {
  readonly Id?: string;
}

interface ExecInspectResponse {
  readonly ExitCode?: number | null;
  readonly Running?: boolean;
}

export interface ExecOptions {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

interface ExecSession {
  readonly api: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly service: ServicePlan;
  readonly user?: string;
}

const containerName = (plan: AppPlan, service: ServicePlan) =>
  `lando-${plan.slug}-${service.name}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");

const apiRequired = (ctx: ProviderErrorContext): ProviderUnavailableError =>
  missingApi(ctx, "exec", `provider-${ctx.providerId} exec requires an engine API client.`);

const missingService = (ctx: ProviderErrorContext, target: ExecTarget) =>
  new ServiceNotFoundError({
    providerId: ctx.providerId,
    operation: "exec",
    service: target.service,
    message: `Service ${target.service} is not present in the app plan.`,
  });

const execFailure = (
  session: ExecSession,
  failure: { readonly message: string; readonly details: unknown },
) =>
  new ServiceExecError({
    providerId: session.ctx.providerId,
    operation: "exec",
    service: session.service.name,
    message: failure.message,
    details: failure.details,
  });

const execStartHttpStatus = (error: ExecError): number | undefined => {
  if (!(error instanceof ProviderUnavailableError) && !(error instanceof ProviderInternalError)) {
    return undefined;
  }
  const details = error.details;
  if (typeof details !== "object" || details === null || !("status" in details)) return undefined;
  const status = details.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
};

const execStartFailure = (session: ExecSession, target: ExecTarget, error: ExecError): ExecError => {
  const status = execStartHttpStatus(error);
  if (status === undefined) return error;
  const requestedUser = target.user;
  return new ServiceExecError({
    providerId: session.ctx.providerId,
    operation: "exec",
    service: session.service.name,
    message:
      requestedUser === undefined
        ? `Container runtime rejected the exec request for service ${String(session.service.name)}.`
        : `Container runtime rejected the exec request for service ${String(session.service.name)} using the requested user.`,
    details: {
      status,
      ...(requestedUser === undefined ? {} : { requestedUser }),
    },
    remediation:
      requestedUser === undefined
        ? "Verify the command and service state, then retry."
        : "Verify that the requested user exists in the service container, or retry without --user.",
    cause: error,
  });
};

const request = (
  session: ExecSession,
  input: EngineHttpRequest,
): Effect.Effect<EngineHttpResponse, ExecError> =>
  session.api.request === undefined ? Effect.fail(apiRequired(session.ctx)) : session.api.request(input);

const stream = (session: ExecSession, input: EngineHttpRequest): Stream.Stream<Uint8Array, ExecError> =>
  session.api.stream === undefined ? Stream.fail(apiRequired(session.ctx)) : session.api.stream(input);

const parseJson = (
  ctx: ProviderErrorContext,
  response: EngineHttpResponse,
  operation: string,
): Effect.Effect<unknown, ProviderInternalError> =>
  Effect.try({
    try: () => (response.body.length === 0 ? {} : JSON.parse(response.body)),
    catch: (cause) =>
      new ProviderInternalError({
        providerId: ctx.providerId,
        operation,
        message: `provider-${ctx.providerId} API returned invalid JSON.`,
        cause,
      }),
  });

const createExec = (
  session: ExecSession,
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
): Effect.Effect<string, ExecError> =>
  Effect.gen(function* () {
    const response = yield* request(session, {
      method: "POST",
      path: `/containers/${encodeURIComponent(containerName(plan, session.service))}/exec`,
      body: {
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: command.stdin === "inherit" || command.stdinStream !== undefined,
        Cmd: command.command,
        Tty: command.tty === true,
        ...(target.user === undefined ? {} : { User: target.user }),
        ...(command.cwd === undefined ? {} : { WorkingDir: command.cwd }),
        ...(command.env === undefined
          ? {}
          : { Env: Object.entries(command.env).map(([key, value]) => `${key}=${value}`) }),
        ...(session.user === undefined ? {} : { User: session.user }),
      },
    });

    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        execFailure(session, {
          message: `provider-${session.ctx.providerId} failed to create an exec session.`,
          details: response,
        }),
      );
    }

    const decoded = (yield* parseJson(session.ctx, response, "exec.create")) as ExecCreateResponse;
    const execId = decoded.Id;
    if (typeof execId !== "string" || execId.length === 0) {
      yield* Effect.fail(
        execFailure(session, {
          message: `provider-${session.ctx.providerId} exec create response did not include an exec id.`,
          details: response,
        }),
      );
      return "";
    }

    return execId;
  });

const inspectExecState = (
  session: ExecSession,
  execId: string,
): Effect.Effect<number | undefined, ExecError> =>
  Effect.gen(function* () {
    const response = yield* request(session, {
      method: "GET",
      path: `/exec/${encodeURIComponent(execId)}/json`,
    });
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        execFailure(session, {
          message: `provider-${session.ctx.providerId} failed to inspect an exec session.`,
          details: response,
        }),
      );
    }

    const decoded = (yield* parseJson(session.ctx, response, "exec.inspect")) as ExecInspectResponse;
    if (decoded.Running === true) return undefined;
    const exitCode = decoded.ExitCode;
    if (typeof exitCode !== "number") {
      yield* Effect.fail(
        execFailure(session, {
          message: `provider-${session.ctx.providerId} exec inspect response did not include an exit code.`,
          details: response,
        }),
      );
      return 1;
    }

    return exitCode;
  });

const inspectExec = (session: ExecSession, execId: string): Effect.Effect<number, ExecError> =>
  inspectExecState(session, execId).pipe(
    Effect.flatMap((exitCode) =>
      exitCode === undefined
        ? Effect.fail(
            execFailure(session, {
              message: "Podman exec stream ended while the command was still running.",
              details: { execId },
            }),
          )
        : Effect.succeed(exitCode),
    ),
  );

type ExecPollOutcome = "running" | { readonly exitCode: number } | { readonly error: ExecError };

const waitForExecCompletion = (
  session: ExecSession,
  execId: string,
  responseStarted: Promise<void>,
  completedExitCode: Ref.Ref<number | undefined>,
  completionAbort: AbortController,
  lastOutputAt: Ref.Ref<number>,
): Effect.Effect<void, ExecError> =>
  Effect.gen(function* () {
    // A not-yet-started Podman exec also reports Running=false, ExitCode=0.
    // Begin inspecting only after /start has returned its response headers.
    yield* Effect.promise(() => responseStarted);
    const last = yield* Ref.make<ExecPollOutcome>("running");
    yield* runProbe(
      {
        id: "podman-exec-completion",
        // Exec commands can run indefinitely. This is effectively unbounded
        // while keeping the shared probe policy's finite attempt contract.
        policy: { maxAttempts: Number.MAX_SAFE_INTEGER, delay: Duration.millis(100) },
        classify: {
          success: (value) => (value === "running" ? "yellow" : "green"),
          failure: () => "green",
        },
      },
      inspectExecState(session, execId).pipe(
        Effect.map((exitCode): ExecPollOutcome => (exitCode === undefined ? "running" : { exitCode })),
        Effect.catchAll((error) => Effect.succeed({ error } as const)),
        Effect.tap((outcome) => Ref.set(last, outcome)),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        execFailure(session, {
          message: "Podman exec completion probe failed.",
          details: { execId, cause },
        }),
      ),
    );
    const outcome = yield* Ref.get(last);
    if (outcome === "running") {
      return yield* Effect.fail(
        execFailure(session, {
          message: "Podman exec completion probe exhausted its attempts.",
          details: { execId },
        }),
      );
    }
    if ("error" in outcome) return yield* Effect.fail(outcome.error);
    yield* Ref.set(completedExitCode, outcome.exitCode);
    // Podman can report the exit before its final attached output frame
    // reaches the named pipe. Close only after the attached stream is idle.
    yield* runProbe(
      {
        id: "podman-exec-output-drain",
        policy: { maxAttempts: Number.MAX_SAFE_INTEGER, delay: Duration.millis(100) },
        classify: {
          success: (idle) => (idle ? "green" : "yellow"),
          failure: () => "red",
        },
      },
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastOutputAt);
        return now - last >= 500;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        execFailure(session, {
          message: "Podman exec output drain probe failed.",
          details: { execId, cause },
        }),
      ),
    );
    completionAbort.abort();
  });

const resizeExec = (
  session: ExecSession,
  execId: string,
  size: { readonly columns: number; readonly rows: number },
): Effect.Effect<void, ExecError> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({ h: String(size.rows), w: String(size.columns) });
    const response = yield* request(session, {
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/resize?${params.toString()}` as `/${string}`,
    });
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        execFailure(session, {
          message: `provider-${session.ctx.providerId} failed to resize an exec session.`,
          details: response,
        }),
      );
    }
  });

const interruptOnSignal = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.async<void>((resume) => {
        if (signal.aborted) {
          resume(Effect.void);
          return;
        }
        const abort = () => resume(Effect.void);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });

export const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> => {
  const ctx = options.ctx;
  const service = plan.services[target.service];
  if (service === undefined) {
    return Stream.fail(missingService(ctx, target));
  }
  if (options.api === undefined) {
    return Stream.fail(apiRequired(ctx));
  }

  const session: ExecSession = {
    api: options.api,
    ctx,
    service,
    ...(target.user === undefined ? {} : { user: target.user }),
  };

  return Stream.fromEffect(createExec(session, plan, target, command)).pipe(
    Stream.flatMap((execId) => {
      const decodeChunk = makeRuntimeAttachDecoder();
      const completionAbort = new AbortController();
      const resizeEvents = command.terminalResize ?? Stream.empty;
      let signalResponseStarted: () => void = () => undefined;
      const responseStarted = new Promise<void>((resolve) => {
        signalResponseStarted = resolve;
      });
      const start = stream(session, {
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        signal:
          command.signal === undefined
            ? completionAbort.signal
            : AbortSignal.any([command.signal, completionAbort.signal]),
        ...(command.stdinStream === undefined ? {} : { stdin: command.stdinStream }),
        body: { Detach: false, Tty: command.tty === true },
        onResponseHead: signalResponseStarted,
      }).pipe(
        Stream.mapError((error) => execStartFailure(session, target, error)),
        command.tty === true
          ? Stream.map((chunk): ExecChunk => ({ kind: "stdout", chunk }))
          : Stream.flatMap((chunk) =>
              Stream.fromIterable(
                decodeChunk(chunk).map((frame) => ({ kind: frame.stream, chunk: frame.payload })),
              ),
            ),
      );

      return Stream.fromEffect(
        Effect.gen(function* () {
          const completedExitCode = yield* Ref.make<number | undefined>(undefined);
          const lastOutputAt = yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.make(now)));
          if (command.terminalSize !== undefined) {
            // Podman requires the exec to be started before resize; a pre-start
            // resize must not fail the session.
            yield* resizeExec(session, execId, command.terminalSize).pipe(Effect.catchAll(() => Effect.void));
          }
          yield* resizeEvents.pipe(
            Stream.runForEach((size) => resizeExec(session, execId, size)),
            Effect.forkScoped,
          );
          const attached =
            session.api.execAttachNeedsInspectCompletion === true
              ? start.pipe(
                  Stream.tap(() =>
                    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(lastOutputAt, now))),
                  ),
                  Stream.interruptWhen(
                    waitForExecCompletion(
                      session,
                      execId,
                      responseStarted,
                      completedExitCode,
                      completionAbort,
                      lastOutputAt,
                    ),
                  ),
                  Stream.catchAll((error) =>
                    Stream.fromEffect(Ref.get(completedExitCode)).pipe(
                      Stream.flatMap((exitCode) =>
                        exitCode !== undefined &&
                        completionAbort.signal.aborted &&
                        error instanceof ProviderUnavailableError &&
                        error.cause instanceof DOMException &&
                        error.cause.name === "AbortError"
                          ? Stream.empty
                          : Stream.fail(error),
                      ),
                    ),
                  ),
                )
              : start;
          return attached.pipe(
            Stream.concat(
              Stream.fromEffect(
                Ref.get(completedExitCode).pipe(
                  Effect.flatMap((code) =>
                    code !== undefined
                      ? Effect.succeed(code)
                      : session.api.execAttachNeedsInspectCompletion === true
                        ? waitForExecCompletion(
                            session,
                            execId,
                            responseStarted,
                            completedExitCode,
                            completionAbort,
                            lastOutputAt,
                          ).pipe(
                            Effect.zipRight(Ref.get(completedExitCode)),
                            Effect.map((exitCode) => exitCode ?? 1),
                          )
                        : inspectExec(session, execId),
                  ),
                  Effect.map((exitCode) => ({ exitCode })),
                ),
              ),
            ),
            Stream.interruptWhen(interruptOnSignal(command.signal)),
          );
        }),
        // biome-ignore lint/correctness/noFlatMapIdentity: Effect Stream does not provide a flat combinator.
      ).pipe(Stream.flatMap((startWithExit) => startWithExit));
    }),
  );
};

export const exec = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Effect.Effect<ExecResult, ProviderError> =>
  execStream(plan, target, command, options).pipe(
    Stream.runCollect,
    Effect.scoped,
    Effect.map((chunks) => {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for (const chunk of chunks) {
        if ("exitCode" in chunk) {
          exitCode = chunk.exitCode;
        } else if (chunk.kind === "stdout") {
          stdout += textDecoder.decode(chunk.chunk);
        } else {
          stderr += textDecoder.decode(chunk.chunk);
        }
      }

      return { exitCode, stdout, stderr };
    }),
  );
