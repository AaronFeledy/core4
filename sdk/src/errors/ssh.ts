import { Schema } from "effect";

export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  message: Schema.String,
  sshId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
