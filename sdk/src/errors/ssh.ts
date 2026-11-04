import { Schema } from "effect";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  message: Schema.String,
  sshId: Schema.String,
  remediation: Remediation,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class SshAgentUnavailableError extends Schema.TaggedError<SshAgentUnavailableError>()(
  "SshAgentUnavailableError",
  {
    message: Schema.String,
    mode: Schema.Literals(["sidecar", "host"]),
    reason: Schema.Literals([
      "host-agent-not-found",
      "socket-missing",
      "socket-not-socket",
      "socket-owner-mismatch",
      "env-socket-dangling",
      "capability-missing",
      "sidecar-not-running",
      "bridge-failed",
    ]),
    socketPath: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String).annotate({
      description:
        "Redacted reason from the last sidecar readiness probe, when one failed with a concrete cause.",
    }),
    remediation: Remediation,
  },
) {}

export class SshAgentTransportError extends Schema.TaggedError<SshAgentTransportError>()(
  "SshAgentTransportError",
  {
    message: Schema.String,
    stage: Schema.Literals(["broker", "worker", "bridge"]),
    remediation: Remediation,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
