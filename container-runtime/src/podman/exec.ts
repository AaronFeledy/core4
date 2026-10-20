import { Clock, DateTime, Duration, Effect, Option, Ref, type Scope, Stream } from "effect";
import { serviceContainerName } from "../plan.ts";

import {
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  type ServiceNotFoundError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { runProbe } from "@lando/sdk/probe";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import {
  type CommandSpec,
  EventService,
  type ExecChunk,
  type ExecResult,
  type ExecTarget,
  type ProviderError,
} from "@lando/sdk/services";

import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi, missingService, parseEngineJson } from "../engine-errors.ts";
import { httpResponseDetails, redactDetails } from "../redact.ts";
import { makeAttachDecoder as makeRuntimeAttachDecoder } from "../streams.ts";
import { ContainerTransportError } from "../transport.ts";
import {
  EXEC_UMASK_PROBE_COMMAND,
  EXEC_UMASK_SHELL_PROBE_COMMAND,
  type ExecUmaskProbeResult,
  type ShellProbeOutcome,
  claimMissingShellWarning,
  isWorldWritableUmask,
  isWrappedExecCommand,
  missingShellWarning,
  parseProcSelfStatusUmask,
  peekContainerHasShell,
  peekExecUmask,
  peekUnavailableExecUmask,
  rememberContainerHasShell,
  rememberExecUmask,
  rememberUnavailableExecUmask,
  shellProbeOutcome,
  wrapExecCommand,
} from "./exec-umask.ts";

const textDecoder = new TextDecoder();

// Podman reports its own stdin copy failing after the exec'd process exits and closes the attach socket.
const PODMAN_ATTACH_STDIN_COPY_ERROR =
  /^Error: (?:read|write) unixpacket [^\r\n]+\/attach: (?:read|write): (?:connection reset by peer|broken pipe)\n(?![\s\S])/u;

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
  /** Skip umask probe and wrap. Internal probes set this; argv matching must not. */
  readonly raw?: boolean;
  readonly onWarn?: (message: string) => void;
}

interface ExecSession {
  readonly api: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
  readonly service: ServicePlan;
  readonly user?: string;
}

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

const execFailure = (
  session: ExecSession,
  failure: { readonly message: string; readonly details: unknown },
) =>
  new ServiceExecError({
    providerId: session.ctx.providerId,
    operation: "exec",
    service: session.service.name,
    message: failure.message,
    details: redactDetails(failure.details),
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
  session.api.request === undefined
    ? Effect.fail(missingApi(session.ctx, "exec"))
    : session.api.request(input);

const stream = (session: ExecSession, input: EngineHttpRequest): Stream.Stream<Uint8Array, ExecError> =>
  session.api.stream === undefined ? Stream.fail(missingApi(session.ctx, "exec")) : session.api.stream(input);

const createExec = Effect.fnUntraced(function* (
  session: ExecSession,
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
): Effect.fn.Return<string, ExecError> {
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
        details: httpResponseDetails(response),
      }),
    );
  }

  const decoded = (yield* parseEngineJson(response, session.ctx, "exec.create")) as ExecCreateResponse;
  const execId = decoded.Id;
  if (typeof execId !== "string" || execId.length === 0) {
    yield* Effect.fail(
      execFailure(session, {
        message: `provider-${session.ctx.providerId} exec create response did not include an exec id.`,
        details: httpResponseDetails(response),
      }),
    );
    return "";
  }

  return execId;
});

const inspectExecState = Effect.fnUntraced(function* (
  session: ExecSession,
  execId: string,
): Effect.fn.Return<number | undefined, ExecError> {
  const response = yield* request(session, {
    method: "GET",
    path: `/exec/${encodeURIComponent(execId)}/json`,
  });
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      execFailure(session, {
        message: `provider-${session.ctx.providerId} failed to inspect an exec session.`,
        details: httpResponseDetails(response),
      }),
    );
  }

  const decoded = (yield* parseEngineJson(response, session.ctx, "exec.inspect")) as ExecInspectResponse;
  if (decoded.Running === true) return undefined;
  const exitCode = decoded.ExitCode;
  if (typeof exitCode !== "number") {
    yield* Effect.fail(
      execFailure(session, {
        message: `provider-${session.ctx.providerId} exec inspect response did not include an exit code.`,
        details: httpResponseDetails(response),
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

const waitForExecCompletion = Effect.fnUntraced(function* (
  session: ExecSession,
  execId: string,
  responseStarted: Promise<void>,
  completedExitCode: Ref.Ref<number | undefined>,
  completionAbort: AbortController,
  lastOutputAt: Ref.Ref<number>,
): Effect.fn.Return<void, ExecError> {
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
      Effect.catch((error) => Effect.succeed({ error } as const)),
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

const resizeExec = Effect.fnUntraced(function* (
  session: ExecSession,
  execId: string,
  size: { readonly columns: number; readonly rows: number },
): Effect.fn.Return<void, ExecError> {
  const params = new URLSearchParams({ h: String(size.rows), w: String(size.columns) });
  const response = yield* request(session, {
    method: "POST",
    path: `/exec/${encodeURIComponent(execId)}/resize?${params.toString()}` as `/${string}`,
  });
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      execFailure(session, {
        message: `provider-${session.ctx.providerId} failed to resize an exec session.`,
        details: httpResponseDetails(response),
      }),
    );
  }
});

const interruptOnSignal = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<void>((resume) => {
        if (signal.aborted) {
          resume(Effect.void);
          return;
        }
        const abort = () => resume(Effect.void);
        signal.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", abort));
      });

const rawExecCommand = (command: ReadonlyArray<string>): CommandSpec => ({
  command: [...command],
  raw: true,
});

const inspectContainerId = (session: ExecSession, plan: AppPlan): Effect.Effect<string | undefined, never> =>
  request(session, {
    method: "GET",
    path: `/containers/${encodeURIComponent(containerName(plan, session.service))}/json`,
  }).pipe(
    Effect.map((response): string | undefined => {
      if (response.status < 200 || response.status >= 300) return undefined;
      try {
        const decoded = JSON.parse(response.body) as { readonly Id?: unknown };
        return typeof decoded.Id === "string" && decoded.Id.length > 0 ? decoded.Id : undefined;
      } catch {
        return undefined;
      }
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const probeUmask = (
  plan: AppPlan,
  target: ExecTarget,
  options: ExecOptions,
): Effect.Effect<ExecUmaskProbeResult, never, Scope.Scope> =>
  exec(plan, target, rawExecCommand(EXEC_UMASK_PROBE_COMMAND), { ...options, raw: true }).pipe(
    Effect.map((result): ExecUmaskProbeResult => {
      if (result.exitCode !== 0) return { status: "unavailable" };
      const umask = parseProcSelfStatusUmask(`${result.stdout}${result.stderr}`);
      return umask === undefined ? { status: "unavailable" } : { status: "ok", umask };
    }),
    Effect.catch(() => Effect.succeed({ status: "unavailable" as const })),
  );

const probeContainerHasShell = (
  plan: AppPlan,
  target: ExecTarget,
  options: ExecOptions,
): Effect.Effect<ShellProbeOutcome, never, Scope.Scope> =>
  exec(plan, target, rawExecCommand(EXEC_UMASK_SHELL_PROBE_COMMAND), { ...options, raw: true }).pipe(
    Effect.map((result) => shellProbeOutcome(result.exitCode)),
    Effect.catch(() => Effect.succeed("unknown" as const)),
  );

const warnMissingShell = Effect.fnUntraced(function* (
  session: ExecSession,
  options: ExecOptions,
  containerId: string | undefined,
): Effect.fn.Return<void> {
  if (containerId !== undefined && !claimMissingShellWarning(session.api, containerId)) return;
  const message = missingShellWarning(String(session.service.name));
  options.onWarn?.(message);
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  yield* events.value
    .publish(MessageWarnEvent.make({ body: message, timestamp: yield* DateTime.now }))
    .pipe(Effect.catch(() => Effect.void));
});

const resolveExecUmask = Effect.fnUntraced(function* (
  session: ExecSession,
  plan: AppPlan,
  target: ExecTarget,
  options: ExecOptions,
  containerId: string | undefined,
): Effect.fn.Return<ExecUmaskProbeResult, never, Scope.Scope> {
  const cachedOk = peekExecUmask(session.api);
  if (cachedOk !== undefined) return cachedOk;
  if (containerId !== undefined && peekUnavailableExecUmask(session.api, containerId)) {
    return { status: "unavailable" };
  }
  const probed = yield* probeUmask(plan, target, options);
  if (probed.status === "ok") {
    rememberExecUmask(session.api, probed);
    return probed;
  }
  if (containerId !== undefined) rememberUnavailableExecUmask(session.api, containerId);
  return probed;
});

const resolveExecCommand = Effect.fnUntraced(function* (
  session: ExecSession,
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Effect.fn.Return<CommandSpec, never, Scope.Scope> {
  if (options.raw === true || command.raw === true || isWrappedExecCommand(command.command)) {
    return command;
  }

  const containerId = yield* inspectContainerId(session, plan);
  const umaskResult = yield* resolveExecUmask(session, plan, target, options, containerId);
  if (umaskResult.status !== "ok" || !isWorldWritableUmask(umaskResult.umask)) {
    return command;
  }

  const cachedShell = containerId === undefined ? undefined : peekContainerHasShell(session.api, containerId);
  const shell =
    cachedShell === true
      ? "present"
      : cachedShell === false
        ? "missing"
        : yield* probeContainerHasShell(plan, target, options).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (containerId === undefined) return;
                if (outcome === "present") rememberContainerHasShell(session.api, containerId, true);
                if (outcome === "missing") rememberContainerHasShell(session.api, containerId, false);
              }),
            ),
          );
  if (shell !== "present") {
    if (shell === "missing") yield* warnMissingShell(session, options, containerId);
    return command;
  }

  return { ...command, command: wrapExecCommand(command.command) };
});

export const execStream = (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Stream.Stream<ExecChunk, ProviderError, Scope.Scope> =>
  Stream.suspend(() => {
    const ctx = options.ctx;
    const service = plan.services[target.service];
    if (service === undefined) {
      return Stream.fail(missingService(ctx, target, "exec"));
    }
    if (options.api === undefined) {
      return Stream.fail(missingApi(ctx, "exec"));
    }

    const session: ExecSession = {
      api: options.api,
      ctx,
      service,
      ...(target.user === undefined ? {} : { user: target.user }),
    };

    return Stream.fromEffect(
      resolveExecCommand(session, plan, target, command, options).pipe(
        Effect.flatMap((resolved) => createExec(session, plan, target, resolved)),
      ),
    ).pipe(
      Stream.flatMap((execId) => {
        const decodeChunk = makeRuntimeAttachDecoder();
        const completionAbort = new AbortController();
        const resizeEvents = command.terminalResize ?? Stream.empty;
        const hasStdin = command.stdin === "inherit" || command.stdinStream !== undefined;
        let responseHeadArrived = false;
        let recoveredExitCode: number | undefined;
        let pendingDiagnostic: { readonly kind: "stderr"; readonly chunk: Uint8Array } | undefined;
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
          body: {
            Detach: false,
            Tty: command.tty === true,
            // Size the PTY before the command runs: Podman reads h/w, Docker reads ConsoleSize.
            ...(command.tty === true && command.terminalSize !== undefined
              ? {
                  h: command.terminalSize.rows,
                  w: command.terminalSize.columns,
                  ConsoleSize: [command.terminalSize.rows, command.terminalSize.columns],
                }
              : {}),
          },
          onResponseHead: () => {
            responseHeadArrived = true;
            signalResponseStarted();
          },
        }).pipe(
          Stream.mapError((error) => execStartFailure(session, target, error)),
          command.tty === true
            ? Stream.map((chunk): ExecChunk => ({ kind: "stdout", chunk }))
            : Stream.flatMap((chunk) =>
                Stream.fromIterable(
                  decodeChunk(chunk).flatMap((frame) => {
                    const previous = pendingDiagnostic;
                    pendingDiagnostic = undefined;
                    const output = { kind: frame.stream, chunk: frame.payload };
                    const text = textDecoder.decode(frame.payload);
                    // Delay only the daemon's exact attach-copy frame until completion is proven.
                    if (hasStdin && frame.stream === "stderr" && PODMAN_ATTACH_STDIN_COPY_ERROR.test(text)) {
                      pendingDiagnostic = { kind: "stderr", chunk: frame.payload };
                      return previous === undefined ? [] : [previous];
                    }
                    return previous === undefined ? [output] : [previous, output];
                  }),
                ),
              ),
          Stream.concat(
            Stream.suspend(() => {
              const pending = pendingDiagnostic;
              pendingDiagnostic = undefined;
              return pending === undefined ? Stream.empty : Stream.make(pending);
            }),
          ),
          Stream.catch((error) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const cause = error.cause;
                if (
                  hasStdin &&
                  responseHeadArrived &&
                  command.signal?.aborted !== true &&
                  error instanceof ProviderUnavailableError &&
                  cause instanceof ContainerTransportError &&
                  (cause.kind === "read" || cause.kind === "write") &&
                  (cause.systemCode === "ECONNRESET" || cause.systemCode === "EPIPE")
                ) {
                  recoveredExitCode = yield* inspectExecState(session, execId).pipe(
                    Effect.catch(() => Effect.succeed(undefined)),
                  );
                  if (recoveredExitCode !== undefined) {
                    pendingDiagnostic = undefined;
                    return Stream.empty;
                  }
                }
                const pending = pendingDiagnostic;
                pendingDiagnostic = undefined;
                return pending === undefined
                  ? Stream.fail(error)
                  : Stream.make(pending).pipe(Stream.concat(Stream.fail(error)));
              }),
            ),
          ),
        );

        return Stream.fromEffect(
          Effect.gen(function* () {
            const completedExitCode = yield* Ref.make<number | undefined>(undefined);
            const lastOutputAt = yield* Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.make(now)));
            yield* Effect.gen(function* () {
              // Re-send the size for daemons that ignore it in the start body. Podman
              // accepts resize only after /start returns its response head.
              yield* Effect.promise(() => responseStarted);
              if (command.terminalSize !== undefined) {
                yield* resizeExec(session, execId, command.terminalSize).pipe(
                  Effect.catch(() => Effect.void),
                );
              }
              yield* Stream.runForEach(resizeEvents, (size) => resizeExec(session, execId, size));
            }).pipe(Effect.forkScoped);
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
                    Stream.catch((error) =>
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
                    Effect.map((code) => code ?? recoveredExitCode),
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
                              Effect.andThen(Ref.get(completedExitCode)),
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
  }).pipe(Stream.withSpan("RuntimeProvider.execStream"));

export const exec = Effect.fn("RuntimeProvider.exec")(function* (
  plan: AppPlan,
  target: ExecTarget,
  command: CommandSpec,
  options: ExecOptions,
): Effect.fn.Return<ExecResult, ProviderError, Scope.Scope> {
  const chunks = yield* Stream.runCollect(execStream(plan, target, command, options));
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
}, Effect.scoped);
