import { Effect, Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  type HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  type HostProxySocketStaleError,
  type HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { CommandResultEnvelope, HostProxyRunLandoRequest } from "@lando/sdk/schema";

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

export const WireResponse = Schema.Union(WireOk, WireError);
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
  readonly socketPath?: string;
  readonly url?: string;
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
