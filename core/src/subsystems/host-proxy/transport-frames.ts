import { Schema } from "effect";

import {
  HostProxyAuthenticationError,
  HostProxyBackpressureError,
  HostProxyCommandNotAllowedError,
  HostProxyRecursionError,
  HostProxyTransportUnavailableError,
} from "@lando/sdk/errors";
import { CommandResultEnvelope } from "@lando/sdk/schema";

import type { HostProxyRunLandoResult } from "./dispatch.ts";
import type { WireResponse } from "./transport-wire.ts";

const NdjsonFrame = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("stdout"), chunk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stderr"), chunk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("exit"), code: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
    reason: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  }),
);

export const encodeNdjsonFrame = (response: WireResponse): string => {
  if (response._tag === "ok") {
    return `${JSON.stringify({ kind: "stdout", chunk: JSON.stringify(response.envelope) })}\n${JSON.stringify({ kind: "exit", code: response.exitCode })}\n`;
  }
  return `${JSON.stringify({
    kind: "error",
    code: response.tag,
    message: response.message,
    reason: response.reason,
    remediation: response.remediation,
  })}\n`;
};

const decodeErrorResponse = (frame: typeof NdjsonFrame.Type): never => {
  if (frame.kind !== "error") {
    throw new HostProxyTransportUnavailableError({
      message: "Host-proxy response frame was not an error frame.",
      socketPath: "unknown",
      remediation: "Inspect the host-proxy transport failure.",
    });
  }
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
  let envelope: CommandResultEnvelope | undefined;
  for (const line of lines) {
    const decoded = Schema.decodeUnknownEither(NdjsonFrame)(JSON.parse(line));
    if (decoded._tag === "Left") continue;
    const frame = decoded.right;
    switch (frame.kind) {
      case "stdout": {
        const parsed = Schema.decodeUnknownEither(CommandResultEnvelope)(JSON.parse(frame.chunk));
        if (parsed._tag === "Right") envelope = parsed.right;
        break;
      }
      case "stderr":
        break;
      case "exit":
        if (envelope !== undefined) return { envelope, exitCode: frame.code };
        throw new HostProxyTransportUnavailableError({
          message: "Host-proxy exit frame arrived without a result envelope.",
          socketPath: "unknown",
          remediation: "Inspect the host-proxy transport failure.",
        });
      case "error":
        decodeErrorResponse(frame);
    }
  }
  return undefined;
};
