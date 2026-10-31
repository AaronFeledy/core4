import { HostPlatform } from "@lando/sdk/schema";
import { Schema } from "effect";

export const HOST_PROXY_WORKER_PROTOCOL_VERSION = 3 as const;

// Private worker wire data. Never persist or include this secret-bearing payload in diagnostics.
export const HostProxyWorkerPaths = Schema.Struct({
  userConfRoot: Schema.String,
  userCacheRoot: Schema.String,
  userDataRoot: Schema.String,
  systemPluginRoot: Schema.String,
  platform: HostPlatform,
});

export const HostProxyControlRecord = Schema.Struct({
  appId: Schema.String,
  transport: Schema.Literals(["unix-socket", "tcp-host-gateway"]),
  socketPath: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  protocolVersion: Schema.Number,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  controlToken: Schema.String,
});
export type HostProxyControlRecord = typeof HostProxyControlRecord.Type;

export const HostProxyWorkerRecord = Schema.Struct({
  ...HostProxyControlRecord.fields,
  protocolVersion: Schema.Literal(HOST_PROXY_WORKER_PROTOCOL_VERSION),
  shimPath: Schema.String,
  startedAt: Schema.String,
  appRoot: Schema.String,
  providerId: Schema.String,
  sessionId: Schema.String,
  token: Schema.String,
  configDigest: Schema.String,
  containerUrl: Schema.optionalKey(Schema.String),
  probeServices: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HostProxyWorkerRecord = typeof HostProxyWorkerRecord.Type;

export const LegacyHostProxyWorkerRecord = HostProxyControlRecord;
export type LegacyHostProxyWorkerRecord = typeof LegacyHostProxyWorkerRecord.Type;

export const HostProxyWorkerIdentity = Schema.Struct({
  appId: Schema.String,
  appRoot: Schema.optionalKey(Schema.String),
  providerId: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  transport: Schema.Literals(["unix-socket", "tcp-host-gateway"]),
  protocolVersion: Schema.Number,
  configDigest: Schema.optionalKey(Schema.String),
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  /** Observed SSH reverse-forward liveness for tcp-host-gateway workers; none when no bridge. */
  bridge: Schema.optionalKey(Schema.Literals(["none", "alive", "dead"])),
});
export type HostProxyWorkerIdentity = typeof HostProxyWorkerIdentity.Type;
