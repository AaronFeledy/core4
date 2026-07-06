import { Schema } from "effect";

/**
 * Errors raised by the host-proxy `runLando` dispatch path (§10.10). Both are
 * tagged, carry a machine `_tag` and command id, and surface a human
 * remediation string.
 */

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
    /** Canonical command id the rejected `runLando` request targeted. */
    commandId: Schema.String,
    /** The effective host-proxy allowlist the request was evaluated against. */
    effectiveAllowlist: Schema.Array(Schema.String),
    remediation: Schema.String,
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
    /** Canonical command id that illegally self-allowed. */
    commandId: Schema.String,
    remediation: Schema.String,
  },
) {}
