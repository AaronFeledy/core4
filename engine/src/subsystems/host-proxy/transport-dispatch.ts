import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyOpenUrlSchemeError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { AbsolutePath, HostProxyRequest } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HostProxyOpenerError } from "../../services/host-opener.ts";
import { dispatchRunLando } from "./dispatch.ts";
import { HostProxyOpenPathError } from "./open-target.ts";
import { makeHostProxyCallId } from "./transport-events.ts";
import type { HandlerOptions, HostProxyInFlightRequest } from "./transport-handler-options.ts";
import { type HostProxyTransportError, errorResponse, validateWireRequest } from "./transport-protocol.ts";
import { authenticationFailure, bodyText, messageHeaders } from "./transport-request.ts";
import {
  handleControlPlane,
  invalidRequestResponse,
  rejectRoute,
  requestPathname,
  statusFor,
  writeJsonResponse,
  writeTransportResponse,
} from "./transport-response.ts";
import { writeHostProxyFrame } from "./transport-stream.ts";

const isKnownFailure = (failure: unknown): failure is HostProxyTransportError =>
  failure instanceof HostProxyAuthenticationError ||
  failure instanceof HostProxyBackpressureError ||
  failure instanceof HostProxyCommandNotAllowedError ||
  failure instanceof HostProxyRecursionError ||
  failure instanceof HostProxySocketStaleError ||
  failure instanceof HostProxyTransportUnavailableError ||
  failure instanceof HostProxyOpenUrlSchemeError ||
  failure instanceof HostProxyOpenPathError ||
  failure instanceof HostProxyOpenerError;

const dispatchProgram = Effect.fn("HostProxy.dispatchProgram")(function* (
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
  callId: string,
) {
  const headers = messageHeaders(request, options);
  yield* validateWireRequest(
    { ...headers, request: { _tag: "runLando", argv: [], cwd: AbsolutePath.make("/"), tty: false } },
    options.session,
    options.maxDepth,
    0,
    options.concurrency,
  );
  const body = yield* Effect.tryPromise({
    try: () => bodyText(request, options.bodyReadTimeoutMs),
    catch: () => new TypeError("Invalid host-proxy request."),
  });
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(HostProxyRequest))(body);
  if (decoded._tag === "Failure" || requestPathname(request) !== `/${decoded.success._tag}`)
    return { outcome: "invalid" as const };
  const target = decoded.success;
  const deps = {
    executor: options.executor,
    allowlist: options.allowlist,
    mountInfo: options.mountInfo,
    callerService: headers.callerService,
    depth: headers.depth,
    app: options.app,
    callId,
  };
  switch (target._tag) {
    case "runLando": {
      const result = yield* dispatchRunLando(target, {
        ...deps,
        output: (kind, chunk) => writeHostProxyFrame(response, { kind, chunk }),
      });
      yield* Effect.tryPromise(async () => {
        if (result.stdout !== "")
          await writeHostProxyFrame(response, { kind: "stdout", chunk: result.stdout });
        if (result.stderr !== "")
          await writeHostProxyFrame(response, { kind: "stderr", chunk: result.stderr });
        await writeHostProxyFrame(response, { kind: "exit", code: result.exitCode });
        response.end();
      });
      return { outcome: result.exitCode === 0 ? "success" : "failure", exitCode: result.exitCode };
    }
    case "openUrl":
    case "openPath": {
      if (options.openExecutor === undefined)
        return yield* Effect.fail(
          new HostProxyTransportUnavailableError({
            message: "Host-proxy open execution is unavailable.",
            socketPath: "host-proxy-worker",
            remediation: "Run lando start on the host to replace the worker.",
          }),
        );
      const result = yield* options.openExecutor(target, deps);
      const status =
        result._tag === "ok"
          ? 200
          : result.code === "scheme-not-allowed" || result.code === "command-not-allowed"
            ? 403
            : 500;
      writeJsonResponse(response, status, result);
      return { outcome: result._tag === "ok" ? "success" : result.code };
    }
  }
});

export const makeHostProxyRunLandoHandler =
  (options: HandlerOptions) => (request: IncomingMessage, response: ServerResponse) => {
    const callId = makeHostProxyCallId();
    const start = performance.now();
    const pathname = requestPathname(request);
    const operation =
      pathname === "/runLando"
        ? "runLando"
        : pathname === "/openUrl"
          ? "openUrl"
          : pathname === "/openPath"
            ? "openPath"
            : "invalid";
    let diagnosed = false;
    const diagnostic = (outcome: string, exitCode?: number) => {
      diagnosed = true;
      options.diagnostic?.({
        callId,
        operation,
        outcome,
        durationMs: Math.round(performance.now() - start),
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    };
    if (rejectRoute(request, response)) {
      diagnostic("invalid");
      return;
    }
    if (handleControlPlane(request, response, options)) return;
    const headers = messageHeaders(request, options);
    const auth = authenticationFailure(headers, options.session);
    if (auth !== undefined) {
      writeTransportResponse(response, 401, errorResponse(auth));
      diagnostic(auth._tag);
      return;
    }
    if (options.slots.count >= options.concurrency) {
      const failure = new HostProxyBackpressureError({
        message: "The host-proxy transport is saturated.",
        concurrency: options.concurrency,
        remediation: "Retry after a current call finishes.",
      });
      writeTransportResponse(response, 429, errorResponse(failure));
      diagnostic(failure._tag);
      return;
    }
    options.slots.count++;
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      options.slots.count--;
    };
    const entryRef: { current?: HostProxyInFlightRequest } = {};
    const program = Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dispatchProgram(request, response, options, callId).pipe(Effect.provide(options.runtimeContext)),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value.outcome === "invalid")
          writeTransportResponse(response, 400, invalidRequestResponse, { close: true });
        diagnostic(exit.value.outcome, "exitCode" in exit.value ? exit.value.exitCode : undefined);
        return;
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        response.destroy();
        diagnostic("cancelled");
        return;
      }
      const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      const knownFailure = isKnownFailure(failure);
      const payload = knownFailure ? errorResponse(failure) : invalidRequestResponse;
      diagnostic(knownFailure ? failure._tag : "invalid");
      if (response.headersSent) {
        yield* Effect.tryPromise(() =>
          writeHostProxyFrame(response, {
            kind: "error",
            code: payload.tag,
            message: payload.message,
            remediation: "Retry the call; inspect the host-proxy worker log if it fails again.",
          }),
        ).pipe(Effect.ignore);
        response.end();
      } else
        writeTransportResponse(response, knownFailure ? statusFor(failure) : 400, payload, {
          close: !knownFailure,
        });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          response.off("close", onClose);
          request.off("aborted", onClose);
          request.socket.off("close", onClose);
          releaseSlot();
          if (!diagnosed) diagnostic("cancelled");
          if (entryRef.current !== undefined) options.inFlight.delete(entryRef.current);
        }),
      ),
    );
    const onClose = () => {
      if (!response.writableFinished && entryRef.current !== undefined)
        void Effect.runPromise(Fiber.interrupt(entryRef.current.fiber));
    };
    response.once("close", onClose);
    request.once("aborted", onClose);
    request.socket.once("close", onClose);
    const fiber = Effect.runFork(program);
    const entry = { fiber, response, releaseSlot };
    entryRef.current = entry;
    options.inFlight.add(entry);
    if (response.destroyed) onClose();
  };
