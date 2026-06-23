import { Schema } from "effect";

import { AppPlan } from "./app-plan.ts";
import { AppId, ServiceName } from "./primitives.ts";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));
const TunnelPort = Schema.Number.pipe(Schema.int(), Schema.between(1, 65535));
const LOOPBACK_URL_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])(?:[/?#].*)?$/u;
const isLoopbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port.length > 0
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
  routeId: NonEmptyString,
  hostname: Schema.optional(Schema.String),
});

const TunnelServiceEndpointTarget = Schema.TaggedStruct("service", {
  service: ServiceName,
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
  provider: Schema.optional(Schema.String),
  detached: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type TunnelStartRequest = typeof TunnelStartRequest.Type;

export const TunnelStopRequest = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.optional(Schema.String),
  force: Schema.optional(Schema.Boolean),
});
export type TunnelStopRequest = typeof TunnelStopRequest.Type;

export const TunnelStatusRequest = Schema.Struct({
  sessionId: Schema.String,
  provider: Schema.optional(Schema.String),
});
export type TunnelStatusRequest = typeof TunnelStatusRequest.Type;

export const TunnelSession = Schema.Struct({
  id: Schema.String,
  app: AppId,
  provider: Schema.String,
  target: TunnelTarget,
  publicUrl: Schema.optional(Schema.String),
  status: TunnelStatus,
  detached: Schema.Boolean,
  startedAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type TunnelSession = typeof TunnelSession.Type;

export const TunnelSessionFilter = Schema.Struct({
  app: Schema.optional(AppId),
  provider: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  target: Schema.optional(TunnelTarget),
  detached: Schema.optional(Schema.Boolean),
  status: Schema.optional(TunnelStatus),
});
export type TunnelSessionFilter = typeof TunnelSessionFilter.Type;

export const TunnelServiceContribution = Schema.Struct({
  id: Schema.String,
  module: Schema.String,
  capabilities: TunnelCapabilities,
  enabledByDefault: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
});
export type TunnelServiceContribution = typeof TunnelServiceContribution.Type;
