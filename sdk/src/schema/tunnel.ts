import { Schema } from "effect";

import { AppPlan } from "./app-plan.ts";
import { AppId, ServiceName } from "./primitives.ts";

const TUNNEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TUNNEL_SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TUNNEL_HOSTNAME_PATTERN =
  /^(?:\*\.)?(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const SAFE_HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/u;
const TunnelPort = Schema.Number.pipe(Schema.int(), Schema.between(1, 65535));
const LOOPBACK_URL_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])(?:\/[^\s?#]*)?$/u;

const TunnelIdentifier = Schema.String.pipe(
  Schema.pattern(TUNNEL_IDENTIFIER_PATTERN, {
    message: () => "Expected a tunnel identifier without path separators or control characters.",
  }),
);
const TunnelServiceName = ServiceName.pipe(
  Schema.pattern(TUNNEL_SERVICE_NAME_PATTERN, {
    message: () => "Expected a service name without path separators or control characters.",
  }),
);
const TunnelHostname = Schema.String.pipe(
  Schema.pattern(TUNNEL_HOSTNAME_PATTERN, {
    message: () => "Expected a DNS hostname.",
  }),
);
const isSafeHttpUrl = (value: string): boolean => {
  if (!SAFE_HTTP_URL_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};
const SafeHttpUrl = Schema.String.pipe(
  Schema.filter(isSafeHttpUrl, {
    message: () => "Expected an http(s) URL without credentials, query, or fragment.",
    jsonSchema: { format: "uri", pattern: SAFE_HTTP_URL_PATTERN.source },
  }),
);
const isLoopbackUrl = (value: string): boolean => {
  if (!LOOPBACK_URL_PATTERN.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};
const LoopbackUrl = Schema.String.pipe(
  Schema.filter(isLoopbackUrl, {
    message: () => "Expected a core-created http(s) loopback URL.",
    jsonSchema: { format: "uri", pattern: LOOPBACK_URL_PATTERN.source },
  }),
);

export const TunnelCapabilities = Schema.Struct({
  connectorBinary: Schema.Boolean,
  ephemeralUrls: Schema.Boolean,
  stableUrls: Schema.Boolean,
  basicAuth: Schema.Boolean,
  detached: Schema.Boolean,
});
export type TunnelCapabilities = typeof TunnelCapabilities.Type;

const TunnelRouteTarget = Schema.TaggedStruct("route", {
  routeId: TunnelIdentifier,
  hostname: Schema.optional(TunnelHostname),
});

const TunnelServiceEndpointTarget = Schema.TaggedStruct("service", {
  service: TunnelServiceName,
  port: TunnelPort,
  protocol: Schema.optional(Schema.Literal("http", "https", "tcp")),
});

const TunnelLoopbackTarget = Schema.TaggedStruct("loopback", {
  url: LoopbackUrl,
});

export const TunnelTarget = Schema.Union(
  TunnelRouteTarget,
  TunnelServiceEndpointTarget,
  TunnelLoopbackTarget,
);
export type TunnelTarget = typeof TunnelTarget.Type;

export const TunnelStatus = Schema.Literal("starting", "ready", "stopped", "failed", "unknown");
export type TunnelStatus = typeof TunnelStatus.Type;

export const TunnelStartRequest = Schema.Struct({
  app: AppId,
  target: TunnelTarget,
  plan: Schema.optional(AppPlan),
  provider: Schema.optional(TunnelIdentifier),
  detached: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type TunnelStartRequest = typeof TunnelStartRequest.Type;

export const TunnelStopRequest = Schema.Struct({
  sessionId: TunnelIdentifier,
  provider: Schema.optional(TunnelIdentifier),
  force: Schema.optional(Schema.Boolean),
});
export type TunnelStopRequest = typeof TunnelStopRequest.Type;

export const TunnelStatusRequest = Schema.Struct({
  sessionId: TunnelIdentifier,
  provider: Schema.optional(TunnelIdentifier),
});
export type TunnelStatusRequest = typeof TunnelStatusRequest.Type;

export const TunnelSession = Schema.Struct({
  id: TunnelIdentifier,
  app: AppId,
  provider: TunnelIdentifier,
  target: TunnelTarget,
  publicUrl: Schema.optional(SafeHttpUrl),
  status: TunnelStatus,
  detached: Schema.Boolean,
  startedAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type TunnelSession = typeof TunnelSession.Type;

export const TunnelSessionFilter = Schema.Struct({
  app: Schema.optional(AppId),
  provider: Schema.optional(TunnelIdentifier),
  sessionId: Schema.optional(TunnelIdentifier),
  target: Schema.optional(TunnelTarget),
  detached: Schema.optional(Schema.Boolean),
  status: Schema.optional(TunnelStatus),
});
export type TunnelSessionFilter = typeof TunnelSessionFilter.Type;

export const TunnelServiceContribution = Schema.Struct({
  id: TunnelIdentifier,
  module: Schema.String.pipe(Schema.minLength(1)),
  capabilities: TunnelCapabilities,
  enabledByDefault: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
});
export type TunnelServiceContribution = typeof TunnelServiceContribution.Type;
