import { Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";

import type { HostProxyRunLandoResult } from "./dispatch.ts";
import { HOST_PROXY_MAX_FRAME_BYTES, type WireResponse } from "./transport-wire.ts";

const NdjsonFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stdout"), chunk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stderr"), chunk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Number.check(Schema.isInt()) }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    reason: Schema.optionalKey(Schema.String),
    remediation: Schema.optionalKey(Schema.String),
  }),
]);
type NdjsonErrorFrame = Extract<typeof NdjsonFrame.Type, { kind: "error" }>;

export const encodeNdjsonFrame = (response: WireResponse): string => {
  if (response._tag === "ok") {
    return `${JSON.stringify({ kind: "stdout", chunk: response.stdout })}\n${JSON.stringify({ kind: "stderr", chunk: response.stderr })}\n${JSON.stringify({ kind: "exit", code: response.exitCode })}\n`;
  }
  return `${JSON.stringify({
    kind: "error",
    code: response.tag,
    message: response.message,
    reason: response.reason,
    remediation: response.remediation,
  })}\n`;
};

const decodeErrorResponse = (frame: NdjsonErrorFrame): never => {
  switch (frame.code) {
    case "HostProxyAuthenticationError":
      throw new HostProxyAuthenticationError({
        message: frame.message,
        reason: frame.reason === "missing" || frame.reason === "cross-app" ? frame.reason : "stale",
        remediation:
          frame.remediation ?? "Restart the app so the container receives the current host-proxy token.",
      });
    case "HostProxyBackpressureError":
      throw new HostProxyBackpressureError({
        message: frame.message,
        concurrency: 0,
        remediation: frame.remediation ?? "Retry later.",
      });
    case "HostProxyRecursionError":
      throw new HostProxyRecursionError({
        message: frame.message,
        depth: 1,
        remediation: frame.remediation ?? "Avoid nested host-proxy calls.",
      });
    case "HostProxyCommandNotAllowedError":
      throw new HostProxyCommandNotAllowedError({
        message: frame.message,
        commandId: "unknown",
        effectiveAllowlist: [],
        remediation: frame.remediation ?? "Use a command allowed by the host-proxy runLando policy.",
      });
    default:
      throw new HostProxyTransportUnavailableError({
        message: frame.message,
        socketPath: "unknown",
        remediation: frame.remediation ?? "Inspect the host-proxy transport failure.",
      });
  }
};

export const decodeNdjsonResponse = (raw: string): HostProxyRunLandoResult | undefined => {
  const lines = raw.trim().length === 0 ? [] : raw.trim().split("\n");
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  for (const line of lines) {
    if (Buffer.byteLength(line) > HOST_PROXY_MAX_FRAME_BYTES)
      throw new TypeError("Host-proxy response frame is too large.");
    const decoded = Schema.decodeUnknownResult(NdjsonFrame)(JSON.parse(line));
    if (decoded._tag === "Failure" || exitCode !== undefined)
      throw new TypeError("Invalid host-proxy frame sequence.");
    const frame = decoded.success;
    switch (frame.kind) {
      case "stdout": {
        stdout += frame.chunk;
        break;
      }
      case "stderr":
        stderr += frame.chunk;
        break;
      case "exit":
        exitCode = frame.code;
        break;
      case "error":
        decodeErrorResponse(frame);
    }
  }
  return exitCode === undefined ? undefined : { stdout, stderr, exitCode };
};
