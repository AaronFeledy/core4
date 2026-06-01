import { Schema } from "effect";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
