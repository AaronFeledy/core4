import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Cause, type Context, DateTime, Effect, Exit, type Fiber, Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "@lando/sdk/events";
import { type AppRef, HostProxyRunLandoRequest } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import type { RedactionService } from "../../redaction/service.ts";
import type { HostProxyMountInfo } from "./cwd-remap.ts";
import { type DispatchRunLandoDeps, type HostProxyRunLandoExecutor, dispatchRunLando } from "./dispatch.ts";
import { encodeNdjsonFrame } from "./transport-frames.ts";
import {
  HOST_PROXY_MAX_FRAME_BYTES,
  type WireOk,
  authError,
  errorResponse,
  validateWireRequest,
} from "./transport-protocol.ts";

interface HandlerOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly maxDepth: number;
  readonly concurrency: number;
  readonly bodyReadTimeoutMs: number;
  readonly active: { value: number };
  readonly inFlight: Set<HostProxyInFlightRequest>;
  readonly session: { readonly appId: string; readonly sessionId: string; readonly token: string };
  readonly runtimeContext: Context.Context<EventService | RedactionService>;
}

export interface HostProxyInFlightRequest {
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  readonly response: ServerResponse;
}

const invalidRequestResponse = {
  _tag: "error" as const,
  tag: "HostProxyTransportUnavailableError",
  message: "Invalid host-proxy request.",
};

const now = () => DateTime.unsafeMake(new Date().toISOString());

const headerValue = (request: IncomingMessage, name: string): string => {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

const bodyText = (request: IncomingMessage, timeoutMs: number): Promise<string> =>
  new Promise((resolveText, reject) => {
    let body = "";
    let settled = false;
    let draining = false;
    const timeout = setTimeout(() => {
      rejectOnce(new Error("Host-proxy request body timed out."));
      request.destroy();
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", resolveOnce);
      request.off("close", rejectClosed);
      if (!draining) request.off("error", rejectOnce);
    };
    const rejectOnce = (cause: Error): void => {
      if (settled) return;
      settled = true;
      draining = true;
      body = "";
      request.off("end", resolveOnce);
      request.resume();
      reject(cause);
    };
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveText(body);
    };
    const rejectClosed = (): void => {
      if (!settled) rejectOnce(new Error("Host-proxy request closed before a complete body."));
      cleanup();
    };
    const onData = (chunk: string): void => {
      if (draining) return;
      if (settled) return;
      if (body.length + chunk.length > HOST_PROXY_MAX_FRAME_BYTES) {
        rejectOnce(new Error("Host-proxy request exceeded maximum frame size."));
        return;
      }
      body += chunk;
    };
    request.setEncoding("utf8");
    request.on("data", onData);
    request.on("error", rejectOnce);
    request.on("end", resolveOnce);
    request.on("close", rejectClosed);
  });

const messageHeaders = (request: IncomingMessage, options: HandlerOptions) => {
  const authorization = headerValue(request, "authorization");
  const bearerPrefix = "Bearer ";
  const depth = Number(headerValue(request, "x-lando-host-proxy-depth") || "0");
  return {
    sessionId: headerValue(request, "x-lando-host-proxy-session"),
    appId: headerValue(request, "x-lando-host-proxy-app"),
    token: authorization.startsWith(bearerPrefix) ? authorization.slice(bearerPrefix.length) : "",
    callerService: headerValue(request, "x-lando-host-proxy-caller") || options.callerService,
    depth: Number.isFinite(depth) ? depth : 0,
  };
};

const authenticationFailure = (
  headers: ReturnType<typeof messageHeaders>,
  session: HandlerOptions["session"],
): HostProxyAuthenticationError | undefined => {
  if (headers.token.length === 0) return authError("missing");
  if (headers.appId !== session.appId) return authError("cross-app");
  if (headers.sessionId !== session.sessionId || headers.token !== session.token) return authError("stale");
  return undefined;
};

const writeTransportResponse = (
  response: ServerResponse,
  status: number,
  payload: ReturnType<typeof errorResponse> | WireOk,
  options: { readonly close?: boolean } = {},
): void => {
  if (options.close === true) response.shouldKeepAlive = false;
  response.writeHead(status, {
    "content-type": "application/x-ndjson",
    ...(options.close === true ? { connection: "close" } : {}),
  });
  response.end(encodeNdjsonFrame(payload));
};

const publishRejected = (input: {
  readonly app: AppRef;
  readonly callId: string;
  readonly callerService: string;
  readonly depth: number;
  readonly failureDetail: string;
}) =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const request = { kind: "runLando" };
    yield* events.publish(
      PreHostProxyCallEvent.make({
        app: input.app,
        callId: input.callId,
        request,
        callerService: input.callerService,
        depth: input.depth,
        timestamp: now(),
      }),
    );
    yield* events.publish(
      PostHostProxyCallEvent.make({
        app: input.app,
        callId: input.callId,
        request,
        callerService: input.callerService,
        depth: input.depth,
        outcome: "failure",
        failureDetail: input.failureDetail,
        timestamp: now(),
      }),
    );
  });

const rejectInvalidAuthenticatedRequest = (
  response: ServerResponse,
  options: HandlerOptions,
  headers: ReturnType<typeof messageHeaders>,
): void => {
  writeTransportResponse(response, 400, invalidRequestResponse, { close: true });
  const callId = `hp-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const failureDetail = "HostProxyTransportUnavailableError";
  void Effect.runPromise(
    publishRejected({
      app: options.app,
      callId,
      callerService: headers.callerService,
      depth: headers.depth,
      failureDetail,
    }).pipe(Effect.provide(options.runtimeContext)),
  );
};

const statusFor = (failure: unknown): number => {
  if (failure instanceof HostProxyAuthenticationError) return 401;
  if (failure instanceof HostProxyBackpressureError) return 429;
  return 500;
};

const acquireDispatchSlot = (options: HandlerOptions): Effect.Effect<void, HostProxyBackpressureError> =>
  Effect.flatMap(
    Effect.sync(() => {
      if (options.active.value >= options.concurrency) {
        return new HostProxyBackpressureError({
          message: "The host-proxy runLando transport is saturated.",
          concurrency: options.concurrency,
          remediation: "Retry after the current in-container Lando command finishes.",
        });
      }
      options.active.value += 1;
      return undefined;
    }),
    (failure) => (failure === undefined ? Effect.void : Effect.fail(failure)),
  );

export const makeHostProxyRunLandoHandler =
  (options: HandlerOptions) => (request: IncomingMessage, response: ServerResponse) => {
    const headers = messageHeaders(request, options);
    const authFailure = authenticationFailure(headers, options.session);
    if (authFailure !== undefined) {
      writeTransportResponse(response, 401, errorResponse(authFailure));
      void Effect.runPromise(
        publishRejected({
          app: options.app,
          callId: `hp-${Date.now()}-${randomBytes(4).toString("hex")}`,
          callerService: headers.callerService,
          depth: headers.depth,
          failureDetail: "HostProxyAuthenticationError",
        }).pipe(Effect.provide(options.runtimeContext)),
      );
      return;
    }

    let slotReleased = false;
    const releaseDispatchSlot = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      options.active.value -= 1;
    };

    void Effect.runPromiseExit(acquireDispatchSlot(options)).then((slotExit) => {
      if (Exit.isFailure(slotExit)) {
        const failure = slotExit.cause._tag === "Fail" ? slotExit.cause.error : undefined;
        const payload =
          failure instanceof HostProxyBackpressureError
            ? errorResponse(failure)
            : {
                _tag: "error" as const,
                tag: "HostProxyTransportUnavailableError",
                message: "Host-proxy dispatch failed.",
              };
        writeTransportResponse(response, statusFor(failure), payload);
        void Effect.runPromise(
          publishRejected({
            app: options.app,
            callId: `hp-${Date.now()}-${randomBytes(4).toString("hex")}`,
            callerService: headers.callerService,
            depth: headers.depth,
            failureDetail:
              failure instanceof HostProxyBackpressureError
                ? failure._tag
                : "HostProxyTransportUnavailableError",
          }).pipe(Effect.provide(options.runtimeContext)),
        );
        return;
      }

      void bodyText(request, options.bodyReadTimeoutMs)
        .then((body) => {
          const decodedRequest = Schema.decodeUnknownEither(HostProxyRunLandoRequest)(JSON.parse(body));
          if (decodedRequest._tag === "Left") {
            releaseDispatchSlot();
            rejectInvalidAuthenticatedRequest(response, options, headers);
            return;
          }
          const wire = {
            ...headers,
            request: decodedRequest.right,
          };
          const program = validateWireRequest(
            wire,
            options.session,
            options.maxDepth,
            0,
            options.concurrency,
          ).pipe(
            Effect.flatMap(() => {
              const deps: DispatchRunLandoDeps = {
                executor: options.executor,
                allowlist: options.allowlist,
                mountInfo: options.mountInfo,
                callerService: wire.callerService,
                depth: wire.depth,
                app: options.app,
              };
              return dispatchRunLando(wire.request, deps).pipe(
                Effect.map(
                  (result): WireOk => ({ _tag: "ok", envelope: result.envelope, exitCode: result.exitCode }),
                ),
              );
            }),
            Effect.ensuring(Effect.sync(releaseDispatchSlot)),
          );
          const respond = Effect.gen(function* () {
            const exit = yield* Effect.exit(program.pipe(Effect.provide(options.runtimeContext)));
            if (Exit.isSuccess(exit)) {
              writeTransportResponse(response, 200, exit.value);
              return;
            }
            if (Cause.isInterruptedOnly(exit.cause)) {
              response.destroy();
              return;
            }
            const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
            const knownFailure =
              failure instanceof HostProxyAuthenticationError ||
              failure instanceof HostProxyBackpressureError ||
              failure instanceof HostProxyCommandNotAllowedError ||
              failure instanceof HostProxyRecursionError ||
              failure instanceof HostProxySocketStaleError ||
              failure instanceof HostProxyTransportUnavailableError;
            const payload = knownFailure
              ? errorResponse(failure)
              : {
                  _tag: "error" as const,
                  tag: "HostProxyTransportUnavailableError",
                  message: "Host-proxy dispatch failed.",
                };
            if (
              failure instanceof HostProxyAuthenticationError ||
              failure instanceof HostProxyBackpressureError ||
              failure instanceof HostProxyRecursionError
            ) {
              void Effect.runPromise(
                publishRejected({
                  app: options.app,
                  callId: `hp-${Date.now()}-${randomBytes(4).toString("hex")}`,
                  callerService: wire.callerService,
                  depth: wire.depth,
                  failureDetail: failure._tag,
                }).pipe(Effect.provide(options.runtimeContext)),
              );
            }
            writeTransportResponse(response, statusFor(failure), payload);
          });
          const entryRef: { current?: HostProxyInFlightRequest } = {};
          const fiber = Effect.runFork(
            respond.pipe(
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
        })
        .catch(() => {
          releaseDispatchSlot();
          rejectInvalidAuthenticatedRequest(response, options, headers);
        });
    });
  };
