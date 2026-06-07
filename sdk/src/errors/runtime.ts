import { Schema } from "effect";

export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  message: Schema.String,
  event: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
  decodeError: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", {
  message: Schema.String,
  proxyId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CaError extends Schema.TaggedError<CaError>()("CaError", {
  message: Schema.String,
  caId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HostProxyError extends Schema.TaggedError<HostProxyError>()("HostProxyError", {
  message: Schema.String,
  hostProxyId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class LandoRuntimeBootstrapError extends Schema.TaggedError<LandoRuntimeBootstrapError>()(
  "LandoRuntimeBootstrapError",
  {
    message: Schema.String,
    stage: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LandoCommandError extends Schema.TaggedError<LandoCommandError>()("LandoCommandError", {
  message: Schema.String,
  commandId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()("NotImplementedError", {
  message: Schema.String,
  commandId: Schema.String,
  remediation: Schema.String,
}) {}

export class RendererSelectionError extends Schema.TaggedError<RendererSelectionError>()(
  "RendererSelectionError",
  {
    message: Schema.String,
    value: Schema.String,
    source: Schema.Literal("flag", "env", "config"),
    remediation: Schema.String,
  },
) {}
