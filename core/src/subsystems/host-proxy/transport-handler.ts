import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Cause, type Context, DateTime, Effect, Exit, type Fiber, Option, Schema } from "effect";

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
import type { HostProxyTransportKind } from "./transport.ts";

interface HandlerOptions {
  readonly app: AppRef;
  readonly mountInfo: HostProxyMountInfo;
  readonly allowlist: ReadonlyArray<string>;
  readonly callerService: string;
  readonly executor: HostProxyRunLandoExecutor;
  readonly maxDepth: number;
  readonly concurrency: number;
  readonly bodyReadTimeoutMs: number;
  readonly semaphore: Effect.Semaphore;
  readonly inFlight: Set<HostProxyInFlightRequest>;
  readonly session: {
    readonly appId: string;
    readonly sessionId: string;
    readonly token: string;
    readonly controlToken: string;
  };
  readonly control: {
    readonly token: string;
    readonly transport: HostProxyTransportKind;
    readonly protocolVersion: 1;
    readonly pid: number;
    readonly shutdown: () => Promise<void>;
  };
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

const controlToken = (request: IncomingMessage): string => headerValue(request, "x-lando-host-proxy-control");

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

const writeJsonResponse = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

const writeEmptyResponse = (response: ServerResponse, status: number): void => {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end();
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

const requestPathname = (request: IncomingMessage): string => {
  try {
    return new URL(request.url ?? "", "http://host-proxy.invalid").pathname;
  } catch {
    return "";
  }
};

const rejectRoute = (request: IncomingMessage, response: ServerResponse): boolean => {
  const pathname = requestPathname(request);
  if (pathname === "/runLando" && request.method === "POST") return false;
  if (pathname === "/_lando/host-proxy/identify" && request.method === "GET") return false;
  if (pathname === "/_lando/host-proxy/shutdown" && request.method === "POST") return false;
  const allowed =
    pathname === "/runLando" ||
    pathname === "/_lando/host-proxy/identify" ||
    pathname === "/_lando/host-proxy/shutdown";
  writeJsonResponse(response, allowed ? 405 : 404, {
    _tag: "error",
    tag: "HostProxyTransportUnavailableError",
    message: allowed ? "Host-proxy method is not allowed." : "Host-proxy route was not found.",
  });
  return true;
};

const handleControlPlane = (
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): boolean => {
  const pathname = requestPathname(request);
  if (pathname !== "/_lando/host-proxy/identify" && pathname !== "/_lando/host-proxy/shutdown") return false;
  if (controlToken(request) !== options.control.token) {
    writeJsonResponse(response, 401, {
      _tag: "error",
      tag: "HostProxyAuthenticationError",
      message: "unauthorized",
    });
    return true;
  }
  if (pathname === "/_lando/host-proxy/identify") {
    writeJsonResponse(response, 200, {
      appId: options.session.appId,
      sessionId: options.session.sessionId,
      transport: options.control.transport,
      protocolVersion: options.control.protocolVersion,
      pid: options.control.pid,
    });
    return true;
  }
  writeEmptyResponse(response, 202);
  setImmediate(() => {
    void options.control.shutdown();
  });
  return true;
};

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
          callId: `hp-${Date.now()}-${randomBytes(4).toString("hex")}`,
          callerService: "unauthenticated",
          depth: headers.depth,
          failureDetail: "HostProxyAuthenticationError",
        }).pipe(Effect.provide(options.runtimeContext)),
      );
      return;
    }

    const program = withDispatchSlot(
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

    const respond = Effect.gen(function* () {
      const exit = yield* Effect.exit(program.pipe(Effect.provide(options.runtimeContext)));
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
            callerService: headers.callerService,
            depth: headers.depth,
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
  };
