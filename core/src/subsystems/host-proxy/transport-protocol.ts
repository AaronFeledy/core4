import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Effect, Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxySocketStaleError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { CommandResultEnvelope, HostProxyRunLandoRequest } from "@lando/sdk/schema";

import type { HostProxyRunLandoResult } from "./dispatch.ts";
import { decodeNdjsonResponse } from "./transport-frames.ts";

export const HOST_PROXY_MAX_FRAME_BYTES = 1024 * 1024;

export const WireRequest = Schema.Struct({
  sessionId: Schema.String,
  appId: Schema.String,
  token: Schema.String,
  callerService: Schema.String,
  depth: Schema.Number,
  request: HostProxyRunLandoRequest,
});
export type WireRequest = typeof WireRequest.Type;

const WireOk = Schema.TaggedStruct("ok", {
  envelope: CommandResultEnvelope,
  exitCode: Schema.Number,
});
export type WireOk = typeof WireOk.Type;

const WireError = Schema.TaggedStruct("error", {
  tag: Schema.String,
  message: Schema.String,
  reason: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
});
export type WireError = typeof WireError.Type;

const WireResponse = Schema.Union(WireOk, WireError);
export type WireResponse = typeof WireResponse.Type;

export type HostProxyTransportError =
  | HostProxyAuthenticationError
  | HostProxyBackpressureError
  | HostProxyCommandNotAllowedError
  | HostProxyRecursionError
  | HostProxySocketStaleError
  | HostProxyTransportUnavailableError;

export interface HostProxyRunLandoClientRequest {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

export interface HostProxyRunLandoConnectionSession {
  readonly appId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly socketPath: string;
}

export const authError = (reason: HostProxyAuthenticationError["reason"]): HostProxyAuthenticationError =>
  new HostProxyAuthenticationError({
    message: `Host-proxy runLando authentication failed: ${reason}.`,
    reason,
    remediation: "Restart the app so the container receives the current host-proxy session token.",
  });

export const errorResponse = (error: HostProxyTransportError): WireError => ({
  _tag: "error",
  tag: error._tag,
  message: error.message,
  ...("reason" in error ? { reason: error.reason } : {}),
  ...("remediation" in error ? { remediation: error.remediation } : {}),
});

export const writeResponse = (socket: { end(value: string): void }, response: WireResponse): void => {
  socket.end(`${JSON.stringify(response)}\n`);
};

export const validateWireRequest = (
  message: WireRequest,
  session: Omit<HostProxyRunLandoConnectionSession, "socketPath">,
  maxDepth: number,
  active: number,
  concurrency: number,
): Effect.Effect<
  void,
  HostProxyAuthenticationError | HostProxyBackpressureError | HostProxyRecursionError
> => {
  if (message.token.length === 0) return Effect.fail(authError("missing"));
  if (message.appId !== session.appId) return Effect.fail(authError("cross-app"));
  if (message.sessionId !== session.sessionId || message.token !== session.token)
    return Effect.fail(authError("stale"));
  if (message.depth >= maxDepth) {
    return Effect.fail(
      new HostProxyRecursionError({
        message: "Nested host-proxy runLando calls are not allowed.",
        depth: message.depth,
        remediation: "Run nested Lando lifecycle commands on the host instead of through the container shim.",
      }),
    );
  }
  if (active >= concurrency) {
    return Effect.fail(
      new HostProxyBackpressureError({
        message: "The host-proxy runLando transport is saturated.",
        concurrency,
        remediation: "Retry after the current in-container Lando command finishes.",
      }),
    );
  }
  return Effect.void;
};

const decodeWireResponse = (raw: string): HostProxyRunLandoResult => {
  const decodedNdjson = decodeNdjsonResponse(raw);
  if (decodedNdjson !== undefined) return decodedNdjson;
  if (raw.trim().length === 0) {
    throw new HostProxyTransportUnavailableError({
      message: "Host-proxy returned an empty response.",
      socketPath: "unknown",
      remediation: "Inspect the host-proxy transport failure.",
    });
  }
  const response = Schema.decodeUnknownSync(WireResponse)(JSON.parse(raw));
  if (response._tag === "ok") return { envelope: response.envelope, exitCode: response.exitCode };
  switch (response.tag) {
    case "HostProxyAuthenticationError":
      throw authError(
        response.reason === "missing" || response.reason === "cross-app" ? response.reason : "stale",
      );
    case "HostProxyBackpressureError":
      throw new HostProxyBackpressureError({
        message: response.message,
        concurrency: 0,
        remediation: response.remediation ?? "Retry later.",
      });
    case "HostProxyRecursionError":
      throw new HostProxyRecursionError({
        message: response.message,
        depth: 1,
        remediation: response.remediation ?? "Avoid nested host-proxy calls.",
      });
    case "HostProxyCommandNotAllowedError":
      throw new HostProxyCommandNotAllowedError({
        message: response.message,
        commandId: "unknown",
        effectiveAllowlist: [],
        remediation: response.remediation ?? "Use a command allowed by the host-proxy runLando policy.",
      });
    default:
      throw new HostProxyTransportUnavailableError({
        message: response.message,
        socketPath: "unknown",
        remediation: response.remediation ?? "Inspect the host-proxy transport failure.",
      });
  }
};

export const sendHostProxyRunLando = (
  session: HostProxyRunLandoConnectionSession,
  request: HostProxyRunLandoClientRequest,
  options: { readonly depth?: number; readonly callerService?: string } = {},
): Effect.Effect<HostProxyRunLandoResult, HostProxyTransportError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<HostProxyRunLandoResult>((resolveResult, reject) => {
        let response = "";
        let responseStarted = false;
        let responseEnded = false;
        let settled = false;
        const resolveOnce = (result: HostProxyRunLandoResult): void => {
          if (settled) return;
          settled = true;
          resolveResult(result);
        };
        const rejectOnce = (cause: unknown): void => {
          if (settled) return;
          settled = true;
          reject(cause);
        };
        const rejectIncomplete = (): void => {
          rejectOnce(
            new HostProxyTransportUnavailableError({
              message: "Host-proxy connection closed before a complete response.",
              socketPath: session.socketPath,
              remediation: "Ensure the host-proxy session is running.",
            }),
          );
        };
        const req = httpRequest(
          {
            socketPath: session.socketPath,
            method: "POST",
            path: "/runLando",
            headers: {
              authorization: `Bearer ${session.token}`,
              "content-type": "application/json",
              "x-lando-host-proxy-app": session.appId,
              "x-lando-host-proxy-session": session.sessionId,
              "x-lando-host-proxy-caller": options.callerService ?? "web",
              "x-lando-host-proxy-depth": String(options.depth ?? 0),
            },
          },
          (res) => {
            responseStarted = true;
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              response += chunk;
              if (response.length > HOST_PROXY_MAX_FRAME_BYTES)
                req.destroy(new Error("Host-proxy response exceeded maximum frame size."));
            });
            res.once("aborted", rejectIncomplete);
            res.once("error", rejectOnce);
            res.once("close", () => {
              if (!responseEnded) rejectIncomplete();
            });
            res.once("end", () => {
              responseEnded = true;
              try {
                resolveOnce(decodeWireResponse(response));
              } catch (cause) {
                rejectOnce(cause);
              }
            });
          },
        );
        req.once("error", rejectOnce);
        req.once("close", () => {
          if (!responseStarted) rejectIncomplete();
        });
        req.end(JSON.stringify({ _tag: "runLando", ...request }));
      }),
    catch: (cause) => {
      if (
        cause instanceof HostProxyAuthenticationError ||
        cause instanceof HostProxyBackpressureError ||
        cause instanceof HostProxyCommandNotAllowedError ||
        cause instanceof HostProxyRecursionError ||
        cause instanceof HostProxySocketStaleError ||
        cause instanceof HostProxyTransportUnavailableError
      ) {
        return cause;
      }
      return new HostProxyTransportUnavailableError({
        message: cause instanceof Error ? cause.message : String(cause),
        socketPath: session.socketPath,
        remediation: "Ensure the host-proxy session is running.",
      });
    },
  });

export const connectHostProxyRunLando = (
  session: HostProxyRunLandoConnectionSession,
): Effect.Effect<void, HostProxyTransportUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      await stat(session.socketPath);
    },
    catch: (cause) =>
      new HostProxyTransportUnavailableError({
        message: cause instanceof Error ? cause.message : String(cause),
        socketPath: session.socketPath,
        remediation: "Start the app to create a host-proxy runLando session before invoking the shim.",
      }),
  });
