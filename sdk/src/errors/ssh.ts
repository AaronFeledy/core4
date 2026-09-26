import { Schema } from "effect";

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  message: Schema.String,
  sshId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class SshAgentUnavailableError extends Schema.TaggedError<SshAgentUnavailableError>()(
  "SshAgentUnavailableError",
  {
    message: Schema.String,
    mode: Schema.Literal("sidecar", "host"),
    reason: Schema.Literal(
      "host-agent-not-found",
      "socket-missing",
      "capability-missing",
      "sidecar-not-running",
      "bridge-failed",
    ),
    socketPath: Schema.optional(Schema.String),
    remediation: Schema.String,
  },
) {}

export class SshAgentTransportError extends Schema.TaggedError<SshAgentTransportError>()(
  "SshAgentTransportError",
  {
    message: Schema.String,
    stage: Schema.Literal("broker", "worker", "bridge"),
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
