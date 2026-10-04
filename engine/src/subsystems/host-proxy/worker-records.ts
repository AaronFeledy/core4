import { Schema } from "effect";

export const HOST_PROXY_WORKER_PROTOCOL_VERSION = 1 as const;

export const HostProxyControlRecord = Schema.Struct({
  appId: Schema.String,
  transport: Schema.Literals(["unix-socket", "tcp-host-gateway"]),
  socketPath: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  shimPath: Schema.String,
  protocolVersion: Schema.Literal(HOST_PROXY_WORKER_PROTOCOL_VERSION),
  startedAt: Schema.String,
  pid: Schema.Number,
  controlToken: Schema.String,
});
export type HostProxyControlRecord = typeof HostProxyControlRecord.Type;

export const HostProxyWorkerRecord = Schema.Struct({
  ...HostProxyControlRecord.fields,
  appRoot: Schema.String,
  providerId: Schema.optionalKey(Schema.String),
  containerUrl: Schema.optionalKey(Schema.String),
  probeServices: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HostProxyWorkerRecord = typeof HostProxyWorkerRecord.Type;

export const LegacyHostProxyWorkerRecord = HostProxyControlRecord;
export type LegacyHostProxyWorkerRecord = typeof LegacyHostProxyWorkerRecord.Type;

export const HostProxyWorkerIdentity = Schema.Struct({
  appId: Schema.String,
  sessionId: Schema.String,
  transport: Schema.Literals(["unix-socket", "tcp-host-gateway"]),
  protocolVersion: Schema.Literal(HOST_PROXY_WORKER_PROTOCOL_VERSION),
  pid: Schema.Number,
});
export type HostProxyWorkerIdentity = typeof HostProxyWorkerIdentity.Type;
