import { Effect, Schema } from "effect";

/**
 * Errors raised by `app:open` (`lando open`) target resolution and the
 * host-opener helper. Both are tagged, carry a machine `_tag`, and surface a
 * human remediation string.
 */

/**
 * Raised when `app:open` cannot resolve any openable URL for the app: no proxy
 * routes and no HTTP endpoints. Lists the services `app:info` knows about and
 * points remediation at `proxy:` config.
 */
export class OpenTargetUnresolvedError extends Schema.TaggedError<OpenTargetUnresolvedError>()(
  "OpenTargetUnresolvedError",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    cause: Schema.optional(Schema.Unknown),
    /** App name (as `app:info` reports it). */
    app: Schema.optional(Schema.String),
    /** Names of the services the app declares, so users can see what exists. */
    services: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

/**
 * Raised when a target URL violates the opener's scheme policy. Host-proxy
 * calls accept defaults plus configured schemes, but never file URLs.
 */
export class HostProxyOpenUrlSchemeError extends Schema.TaggedError<HostProxyOpenUrlSchemeError>()(
  "HostProxyOpenUrlSchemeError",
  {
    message: Schema.String,
    detail: Schema.optional(Schema.String),
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Use an allowed URL scheme, or reveal app files by path instead of file: URLs."),
      ),
    ),
    cause: Schema.optional(Schema.Unknown),
    /** The rejected scheme (e.g. `ftp`, `file`). */
    scheme: Schema.optional(Schema.String),
    /** The offending URL. */
    url: Schema.optional(Schema.String),
  },
) {}
