import { Schema } from "effect";

export class GpgAgentUnavailableError extends Schema.TaggedError<GpgAgentUnavailableError>()(
  "GpgAgentUnavailableError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "host-agent-not-found",
      "socket-missing",
      "capability-missing",
      "bridge-failed",
      "gpg-missing",
      "unrestricted-socket",
    ]),
    socketPath: Schema.optional(Schema.String),
    remediation: Schema.String,
  },
) {}

export class GpgAgentTransportError extends Schema.TaggedError<GpgAgentTransportError>()(
  "GpgAgentTransportError",
  {
    message: Schema.String,
    stage: Schema.Literals(["broker", "worker", "bridge"]),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
