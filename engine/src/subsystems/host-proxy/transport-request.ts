import type { IncomingMessage } from "node:http";

import type { HostProxyAuthenticationError } from "@lando/sdk/errors";

import type { HandlerOptions } from "./transport-handler-options.ts";
import { HOST_PROXY_MAX_FRAME_BYTES, authError } from "./transport-protocol.ts";

export interface HostProxyMessageHeaders {
  readonly sessionId: string;
  readonly appId: string;
  readonly token: string;
  readonly callerService: string;
  readonly depth: number;
}

export const headerValue = (request: IncomingMessage, name: string): string => {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

export const bodyText = (request: IncomingMessage, timeoutMs: number): Promise<string> =>
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

export const messageHeaders = (
  request: IncomingMessage,
  options: Pick<HandlerOptions, "callerService">,
): HostProxyMessageHeaders => {
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

export const controlToken = (request: IncomingMessage): string =>
  headerValue(request, "x-lando-host-proxy-control");

export const authenticationFailure = (
  headers: HostProxyMessageHeaders,
  session: HandlerOptions["session"],
): HostProxyAuthenticationError | undefined => {
  if (headers.token.length === 0) return authError("missing");
  if (headers.appId !== session.appId) return authError("cross-app");
  if (headers.sessionId !== session.sessionId || headers.token !== session.token) return authError("stale");
  return undefined;
};
