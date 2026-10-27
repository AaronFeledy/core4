import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  message: Schema.String,
  event: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Literal("timeout")),
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
  decodeError: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", {
  message: Schema.String,
  proxyId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProxySetupError extends Schema.TaggedError<ProxySetupError>()("ProxySetupError", {
  message: Schema.String,
  proxyId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class RouterPortsExhausted extends Schema.TaggedError<RouterPortsExhausted>()("RouterPortsExhausted", {
  message: Schema.String,
  proxyId: Schema.String,
  bindAddress: Schema.String,
  httpTried: Schema.Array(Schema.Number),
  httpsTried: Schema.Array(Schema.Number),
  exhausted: Schema.Literals(["http", "https", "both"]),
  remediation: Remediation,
}) {}

export class RouterPortPinMismatch extends Schema.TaggedError<RouterPortPinMismatch>()(
  "RouterPortPinMismatch",
  {
    message: Schema.String,
    proxyId: Schema.String,
    runningHttp: Schema.Number,
    runningHttps: Schema.Number,
    requestedHttp: Schema.optional(Schema.Number),
    requestedHttps: Schema.optional(Schema.Number),
    remediation: Remediation,
  },
) {}

/**
 * Router file-provider watcher failure. `detail` is already redacted and bounded by the producer.
 * `watcherHost` names the runtime host that actually runs the file watcher (a provider virtual machine on macOS and Windows).
 */
export class RouterWatcherError extends Schema.TaggedError<RouterWatcherError>()("RouterWatcherError", {
  message: Schema.String,
  proxyId: Schema.String,
  failureClass: Schema.Literals(["inotify-limit", "disk", "permission", "other"]),
  watcherHost: Schema.String,
  detail: Schema.String,
  remediation: Remediation,
}) {}

export class ProxyApplyError extends Schema.TaggedError<ProxyApplyError>()("ProxyApplyError", {
  message: Schema.String,
  proxyId: Schema.String,
  app: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CaError extends Schema.TaggedError<CaError>()("CaError", {
  message: Schema.String,
  caId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class HostProxyError extends Schema.TaggedError<HostProxyError>()("HostProxyError", {
  message: Schema.String,
  hostProxyId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class LandoRuntimeBootstrapError extends Schema.TaggedError<LandoRuntimeBootstrapError>()(
  "LandoRuntimeBootstrapError",
  {
    message: Schema.String,
    stage: Schema.Literals(["minimal", "plugins", "commands", "provider", "app", "tooling"]),
    remediation: Remediation,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class LandoCommandError extends Schema.TaggedError<LandoCommandError>()("LandoCommandError", {
  message: Schema.String,
  commandId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()("NotImplementedError", {
  message: Schema.String,
  commandId: Schema.String,
  remediation: Remediation,
}) {}

export class RendererSelectionError extends Schema.TaggedError<RendererSelectionError>()(
  "RendererSelectionError",
  {
    message: Schema.String,
    value: Schema.String,
    source: Schema.Literals(["flag", "env", "config"]),
    remediation: Remediation,
  },
) {}

export class LogLevelSelectionError extends Schema.TaggedError<LogLevelSelectionError>()(
  "LogLevelSelectionError",
  {
    message: Schema.String,
    value: Schema.String,
    source: Schema.Literals(["flag", "env", "config"]),
    remediation: Remediation,
  },
) {}
