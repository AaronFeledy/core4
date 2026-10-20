import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { HostProxyAuthenticationError, HostProxyBackpressureError } from "@lando/sdk/errors";

import { encodeNdjsonFrame } from "./transport-frames.ts";
import type { HandlerOptions } from "./transport-handler-options.ts";
import type { WireOk, errorResponse } from "./transport-protocol.ts";
import { bodyText, controlToken, messageHeaders } from "./transport-request.ts";

export const invalidRequestResponse = {
  _tag: "error" as const,
  tag: "HostProxyTransportUnavailableError",
  message: "Invalid host-proxy request.",
};

export const writeTransportResponse = (
  response: ServerResponse,
  status: number,
  payload: ReturnType<typeof errorResponse> | WireOk,
  options: { readonly close?: boolean } = {},
): void => {
  if (response.destroyed || response.writableEnded) return;
  if (options.close === true) response.shouldKeepAlive = false;
  response.writeHead(status, {
    "content-type": "application/x-ndjson",
    ...(options.close === true ? { connection: "close" } : {}),
  });
  response.end(encodeNdjsonFrame(payload));
};

export const writeJsonResponse = (response: ServerResponse, status: number, payload: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

export const writeEmptyResponse = (response: ServerResponse, status: number): void => {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end();
};

export const statusFor = (failure: unknown): number => {
  if (failure instanceof HostProxyAuthenticationError) return 401;
  if (failure instanceof HostProxyBackpressureError) return 429;
  return 500;
};

export const requestPathname = (request: IncomingMessage): string => {
  try {
    return new URL(request.url ?? "", "http://host-proxy.invalid").pathname;
  } catch (cause) {
    if (cause instanceof TypeError) return "";
    throw cause;
  }
};

export const rejectRoute = (request: IncomingMessage, response: ServerResponse): boolean => {
  const pathname = requestPathname(request);
  if (pathname === "/runLando" && request.method === "POST") return false;
  if (pathname === "/_lando/host-proxy/identify" && request.method === "GET") return false;
  if (pathname === "/_lando/host-proxy/shutdown" && request.method === "POST") return false;
  if (pathname === "/_lando/host-proxy/configure" && request.method === "POST") return false;
  const allowed =
    pathname === "/runLando" ||
    pathname === "/_lando/host-proxy/identify" ||
    pathname === "/_lando/host-proxy/shutdown" ||
    pathname === "/_lando/host-proxy/configure";
  writeJsonResponse(response, allowed ? 405 : 404, {
    _tag: "error",
    tag: "HostProxyTransportUnavailableError",
    message: allowed ? "Host-proxy method is not allowed." : "Host-proxy route was not found.",
  });
  return true;
};

export const handleControlPlane = (
  request: IncomingMessage,
  response: ServerResponse,
  options: HandlerOptions,
): boolean => {
  const pathname = requestPathname(request);
  if (
    pathname !== "/_lando/host-proxy/identify" &&
    pathname !== "/_lando/host-proxy/shutdown" &&
    pathname !== "/_lando/host-proxy/configure"
  )
    return false;
  const matches = (left: string, right: string): boolean =>
    timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
  const credentials = messageHeaders(request, options);
  const hasCredentials = ["authorization", "x-lando-host-proxy-session", "x-lando-host-proxy-app"].some(
    (name) => request.headers[name] !== undefined,
  );
  if (
    !matches(controlToken(request), options.control.token) ||
    ((hasCredentials || pathname === "/_lando/host-proxy/configure") &&
      !(
        matches(credentials.token, options.session.token) &&
        matches(credentials.sessionId, options.session.sessionId) &&
        matches(credentials.appId, options.session.appId)
      ))
  ) {
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
      appRoot: options.app.root,
      providerId: options.control.providerId,
      sessionId: options.session.sessionId,
      transport: options.control.transport,
      protocolVersion: options.control.protocolVersion,
      configDigest: options.control.configDigest,
      pid: options.control.pid,
    });
    return true;
  }
  if (pathname === "/_lando/host-proxy/configure") {
    void (async () => {
      try {
        const body = JSON.parse(await bodyText(request, options.bodyReadTimeoutMs, 16 * 1024 * 1024));
        if (options.control.configure === undefined) {
          writeJsonResponse(response, 400, invalidRequestResponse);
          return;
        }
        await options.control.configure(body);
        writeJsonResponse(response, 200, { configured: true });
      } catch {
        // Invalid or incomplete control input must never echo plan contents or credentials.
        response.shouldKeepAlive = false;
        writeJsonResponse(response, 400, invalidRequestResponse);
      }
    })();
    return true;
  }
  writeEmptyResponse(response, 202);
  setImmediate(() => {
    void options.control.shutdown();
  });
  return true;
};
