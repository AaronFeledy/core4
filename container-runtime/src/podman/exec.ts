import { Effect, type Scope, Stream } from "effect";

import {
  ProviderInternalError,
  type ProviderUnavailableError,
  ServiceExecError,
  ServiceNotFoundError,
} from "@lando/sdk/errors";
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
  missingApi(ctx, "exec", `provider-${ctx.providerId} exec requires a Podman API client.`);

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
        message: "Podman API returned invalid JSON.",
        cause,
      }),
  });

const createExec = (
  session: ExecSession,
  plan: AppPlan,
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
        ...(command.cwd === undefined ? {} : { WorkingDir: command.cwd }),
        ...(command.env === undefined
          ? {}
          : { Env: Object.entries(command.env).map(([key, value]) => `${key}=${value}`) }),
        ...(session.user === undefined ? {} : { User: session.user }),
      },
    });

    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        execFailure(session, { message: "Podman failed to create an exec session.", details: response }),
      );
    }

    const decoded = (yield* parseJson(session.ctx, response, "exec.create")) as ExecCreateResponse;
    const execId = decoded.Id;
    if (typeof execId !== "string" || execId.length === 0) {
      yield* Effect.fail(
        execFailure(session, {
          message: "Podman exec create response did not include an exec id.",
          details: response,
        }),
      );
      return "";
    }

    return execId;
  });

const inspectExec = (session: ExecSession, execId: string): Effect.Effect<number, ExecError> =>
  Effect.gen(function* () {
    const response = yield* request(session, {
      method: "GET",
      path: `/exec/${encodeURIComponent(execId)}/json`,
    });
    if (response.status < 200 || response.status >= 300) {
      yield* Effect.fail(
        execFailure(session, { message: "Podman failed to inspect an exec session.", details: response }),
      );
    }

    const decoded = (yield* parseJson(session.ctx, response, "exec.inspect")) as ExecInspectResponse;
    const exitCode = decoded.ExitCode;
    if (typeof exitCode !== "number") {
      yield* Effect.fail(
        execFailure(session, {
          message: "Podman exec inspect response did not include an exit code.",
          details: response,
        }),
      );
      return 1;
    }

    return exitCode;
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
        execFailure(session, { message: "Podman failed to resize an exec session.", details: response }),
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

  return Stream.fromEffect(createExec(session, plan, command)).pipe(
    Stream.flatMap((execId) => {
      const decodeChunk = makeRuntimeAttachDecoder();
      const resizeEvents = command.terminalResize ?? Stream.empty;
      const start = stream(session, {
        method: "POST",
        path: `/exec/${encodeURIComponent(execId)}/start`,
        ...(command.signal === undefined ? {} : { signal: command.signal }),
        ...(command.stdinStream === undefined ? {} : { stdin: command.stdinStream }),
        body: { Detach: false, Tty: command.tty === true },
      }).pipe(
        command.tty === true
          ? Stream.map((chunk): ExecChunk => ({ kind: "stdout", chunk }))
          : Stream.flatMap((chunk) =>
              Stream.fromIterable(
                decodeChunk(chunk).map((frame) => ({ kind: frame.stream, chunk: frame.payload })),
              ),
            ),
        Stream.concat(
          Stream.fromEffect(inspectExec(session, execId).pipe(Effect.map((exitCode) => ({ exitCode })))),
        ),
        Stream.interruptWhen(interruptOnSignal(command.signal)),
      );

      return Stream.fromEffect(
        Effect.gen(function* () {
          if (command.terminalSize !== undefined) {
            // Podman requires the exec to be started before resize; a pre-start
            // resize must not fail the session.
            yield* resizeExec(session, execId, command.terminalSize).pipe(Effect.catchAll(() => Effect.void));
          }
          yield* resizeEvents.pipe(
            Stream.runForEach((size) => resizeExec(session, execId, size)),
            Effect.forkScoped,
          );
        }),
      ).pipe(Stream.flatMap(() => start));
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
