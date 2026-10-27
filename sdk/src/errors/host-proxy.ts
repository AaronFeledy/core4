import { Schema } from "effect";

/**
 * Raised when a container forwards a `runLando` request whose canonical command
 * id is not on the generated host-proxy allowlist (`hostProxyAllowed: true`).
 * The effective allowlist is included so a machine consumer can see what is
 * permitted.
 */
export class HostProxyCommandNotAllowedError extends Schema.TaggedError<HostProxyCommandNotAllowedError>()(
  "HostProxyCommandNotAllowedError",
  {
    message: Schema.String,
    commandId: Schema.String,
    effectiveAllowlist: Schema.Array(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

/**
 * Raised at command registration when a command illegally self-allows into the
 * host-proxy allowlist — i.e. a lifecycle/meta command (`app:start`, `app:stop`,
 * `app:restart`, `app:rebuild`, `app:destroy`, `apps:poweroff`, `meta:bun`,
 * `meta:x`) sets `hostProxyAllowed: true`.
 */
export class HostProxyAllowlistConflictError extends Schema.TaggedError<HostProxyAllowlistConflictError>()(
  "HostProxyAllowlistConflictError",
  {
    message: Schema.String,
    commandId: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class HostProxyAuthenticationError extends Schema.TaggedError<HostProxyAuthenticationError>()(
  "HostProxyAuthenticationError",
  {
    message: Schema.String,
    reason: Schema.Literals(["missing", "stale", "cross-app"]),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class HostProxyRecursionError extends Schema.TaggedError<HostProxyRecursionError>()(
  "HostProxyRecursionError",
  {
    message: Schema.String,
    depth: Schema.Number,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class HostProxyBackpressureError extends Schema.TaggedError<HostProxyBackpressureError>()(
  "HostProxyBackpressureError",
  {
    message: Schema.String,
    concurrency: Schema.Number,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class HostProxyTransportUnavailableError extends Schema.TaggedError<HostProxyTransportUnavailableError>()(
  "HostProxyTransportUnavailableError",
  {
    message: Schema.String,
    socketPath: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class HostProxySocketStaleError extends Schema.TaggedError<HostProxySocketStaleError>()(
  "HostProxySocketStaleError",
  {
    message: Schema.String,
    socketPath: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
