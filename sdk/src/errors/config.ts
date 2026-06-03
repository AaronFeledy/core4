import { Schema } from "effect";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised by a `ConfigTranslator`'s `detect`/`translate` when it cannot turn an
 * external configuration source into a Landofile fragment. Carries the
 * originating translator id (when known) so the renderer can attribute the
 * failure.
 */
export class ConfigTranslateError extends Schema.TaggedError<ConfigTranslateError>()("ConfigTranslateError", {
  message: Schema.String,
  translator: Schema.optional(Schema.String),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised when the registered `ConfigTranslator` set is not resolvable because
 * two or more translators declare the same `id`. Resolution is deterministic
 * and order-preserving, so a duplicate id is always a configuration error the
 * user must fix by removing/renaming one contributor.
 */
export class ConfigTranslatorConflictError extends Schema.TaggedError<ConfigTranslatorConflictError>()(
  "ConfigTranslatorConflictError",
  {
    message: Schema.String,
    id: Schema.String,
    translators: Schema.Array(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}
