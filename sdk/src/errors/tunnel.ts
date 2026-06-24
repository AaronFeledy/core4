import { Schema } from "effect";

const tunnelFields = {
  message: Schema.String,
  provider: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
};

export class TunnelProviderUnavailableError extends Schema.TaggedError<TunnelProviderUnavailableError>()(
  "TunnelProviderUnavailableError",
  {
    ...tunnelFields,
    installOptions: Schema.optional(Schema.Array(Schema.String)),
  },
) {}
export class TunnelTargetUnresolvedError extends Schema.TaggedError<TunnelTargetUnresolvedError>()(
  "TunnelTargetUnresolvedError",
  tunnelFields,
) {}
export class TunnelAuthRequiredError extends Schema.TaggedError<TunnelAuthRequiredError>()(
  "TunnelAuthRequiredError",
  tunnelFields,
) {}
export class TunnelStartError extends Schema.TaggedError<TunnelStartError>()(
  "TunnelStartError",
  tunnelFields,
) {}
export class TunnelReadyTimeoutError extends Schema.TaggedError<TunnelReadyTimeoutError>()(
  "TunnelReadyTimeoutError",
  tunnelFields,
) {}
export class TunnelDetachedStateError extends Schema.TaggedError<TunnelDetachedStateError>()(
  "TunnelDetachedStateError",
  tunnelFields,
) {}
export class TunnelStopError extends Schema.TaggedError<TunnelStopError>()("TunnelStopError", tunnelFields) {}
