import type { IncomingMessage, ServerResponse } from "node:http";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { HostProxyRunLandoRequest } from "@lando/sdk/schema";

import { type DispatchRunLandoDeps, dispatchRunLando } from "./dispatch.ts";
import { makeHostProxyCallId, publishRejected } from "./transport-events.ts";
import type { HandlerOptions, HostProxyInFlightRequest } from "./transport-handler-options.ts";
import {
  type HostProxyTransportError,
  type WireOk,
  errorResponse,
  validateWireRequest,
} from "./transport-protocol.ts";
import { authenticationFailure, bodyText, messageHeaders } from "./transport-request.ts";
import {
  handleControlPlane,
  invalidRequestResponse,
  rejectRoute,
  statusFor,
  writeTransportResponse,
} from "./transport-response.ts";

const rejectInvalidAuthenticatedRequest = (
  response: ServerResponse,
  options: HandlerOptions,
  headers: ReturnType<typeof messageHeaders>,
): void => {
  writeTransportResponse(response, 400, invalidRequestResponse, { close: true });
  void Effect.runPromise(
    publishRejected({
      app: options.app,
      callId: makeHostProxyCallId(),
      callerService: headers.callerService,
      depth: headers.depth,
      failureDetail: "HostProxyTransportUnavailableError",
    }).pipe(Effect.provide(options.runtimeContext)),
  );
};

const withDispatchSlot = <A, E, R>(options: HandlerOptions, program: Effect.Effect<A, E, R>) =>
  options.semaphore
    .withPermitsIfAvailable(1)(program)
    .pipe(
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new HostProxyBackpressureError({
                message: "The host-proxy runLando transport is saturated.",
                concurrency: options.concurrency,
                remediation: "Retry after the current in-container Lando command finishes.",
              }),
            ),
      ),
    );

const dispatchProgram = (
  request: IncomingMessage,
  options: HandlerOptions,
  headers: ReturnType<typeof messageHeaders>,
) =>
  withDispatchSlot(
    options,
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise({
        try: () => bodyText(request, options.bodyReadTimeoutMs),
        catch: (cause) => cause,
      }).pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
      if (body === null) return { _tag: "invalid" as const };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return { _tag: "invalid" as const };
      }
      const decodedRequest = Schema.decodeUnknownEither(HostProxyRunLandoRequest)(parsed);
      if (decodedRequest._tag === "Left") return { _tag: "invalid" as const };
      const wire = { ...headers, request: decodedRequest.right };
      yield* validateWireRequest(wire, options.session, options.maxDepth, 0, options.concurrency);
      const deps: DispatchRunLandoDeps = {
        executor: options.executor,
        allowlist: options.allowlist,
        mountInfo: options.mountInfo,
        callerService: wire.callerService,
        depth: wire.depth,
        app: options.app,
      };
      return yield* dispatchRunLando(wire.request, deps).pipe(
        Effect.map(
          (result): WireOk => ({ _tag: "ok", envelope: result.envelope, exitCode: result.exitCode }),
        ),
      );
    }),
  );

const isKnownFailure = (failure: unknown): failure is HostProxyTransportError =>
  failure instanceof HostProxyAuthenticationError ||
  failure instanceof HostProxyBackpressureError ||
  failure instanceof HostProxyCommandNotAllowedError ||
  failure instanceof HostProxyRecursionError ||
  failure instanceof HostProxySocketStaleError ||
  failure instanceof HostProxyTransportUnavailableError;

type RejectedFailure = HostProxyAuthenticationError | HostProxyBackpressureError | HostProxyRecursionError;

const publishesRejectedFailure = (failure: unknown): failure is RejectedFailure =>
  failure instanceof HostProxyAuthenticationError ||
  failure instanceof HostProxyBackpressureError ||
  failure instanceof HostProxyRecursionError;

const respondToRunLando = (
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
  headers: ReturnType<typeof messageHeaders>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      dispatchProgram(request, options, headers).pipe(Effect.provide(options.runtimeContext)),
    );
    if (Exit.isSuccess(exit)) {
      if (exit.value._tag === "invalid") {
        rejectInvalidAuthenticatedRequest(response, options, headers);
        return;
      }
      writeTransportResponse(response, 200, exit.value);
      return;
    }
    if (Cause.isInterruptedOnly(exit.cause)) {
      response.destroy();
      return;
    }
    const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    const payload = isKnownFailure(failure)
      ? errorResponse(failure)
      : {
          _tag: "error" as const,
          tag: "HostProxyTransportUnavailableError",
          message: "Host-proxy dispatch failed.",
        };
    if (publishesRejectedFailure(failure)) {
      void Effect.runPromise(
        publishRejected({
          app: options.app,
          callId: makeHostProxyCallId(),
          callerService: headers.callerService,
          depth: headers.depth,
          failureDetail: failure._tag,
        }).pipe(Effect.provide(options.runtimeContext)),
      );
    }
    writeTransportResponse(response, statusFor(failure), payload);
  });

export const makeHostProxyRunLandoHandler =
  (options: HandlerOptions) => (request: IncomingMessage, response: ServerResponse) => {
    if (rejectRoute(request, response)) return;
    if (handleControlPlane(request, response, options)) return;
    const headers = messageHeaders(request, options);
    const authFailure = authenticationFailure(headers, options.session);
    if (authFailure !== undefined) {
      writeTransportResponse(response, 401, errorResponse(authFailure));
      void Effect.runPromise(
        publishRejected({
          app: options.app,
          callId: makeHostProxyCallId(),
          callerService: "unauthenticated",
          depth: headers.depth,
          failureDetail: "HostProxyAuthenticationError",
        }).pipe(Effect.provide(options.runtimeContext)),
      );
      return;
    }

    const entryRef: { current?: HostProxyInFlightRequest } = {};
    const fiber = Effect.runFork(
      respondToRunLando(request, response, options, headers).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (entryRef.current !== undefined) options.inFlight.delete(entryRef.current);
          }),
        ),
      ),
    );
    const entry = { fiber, response };
    entryRef.current = entry;
    options.inFlight.add(entry);
  };
