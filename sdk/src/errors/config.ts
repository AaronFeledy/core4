import { Effect, Schema } from "effect";
import { ConfigTranslateDiagnostic } from "../schema/config-translate-diagnostic";
import { ValidationIssue } from "../schema/validation-issue";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  issues: Schema.optional(Schema.Array(ValidationIssue)),
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
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  diagnostics: Schema.optional(Schema.Array(ConfigTranslateDiagnostic)),
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
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Remove or rename one of the listed translators so each translator id is unique."),
      ),
    ),
  },
) {}

/**
 * Raised by `app:config:translate` when no `ConfigTranslator` is registered, so
 * there is nothing to translate the input configuration with. Concrete
 * translators ship as plugins, so the remediation points the user at
 * the plugin install path.
 */
export class ConfigTranslateNoTranslatorsError extends Schema.TaggedError<ConfigTranslateNoTranslatorsError>()(
  "ConfigTranslateNoTranslatorsError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "Install a config-translator plugin with `lando plugin:add <translator-plugin>`, then re-run the translation.",
        ),
      ),
    ),
  },
) {}

/**
 * Raised at config validation when `agentEnv.allow`/`agentEnv.deny` contain
 * wildcard or pattern entries instead of exact env-var names. Pattern
 * forwarding is how host secrets leak into containers by accident, so the
 * allowlist is exact-name only. Carries the offending names for remediation.
 */
export class AgentEnvPatternError extends Schema.TaggedError<AgentEnvPatternError>()("AgentEnvPatternError", {
  message: Schema.String,
  patterns: Schema.Array(Schema.String),
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)).pipe(
    Schema.withConstructorDefault(
      Effect.succeed("Replace wildcard or pattern entries in agentEnv.allow/deny with exact env-var names."),
    ),
  ),
}) {}

/**
 * Raised when a Landofile config expression cannot be parsed or evaluated at
 * plan time (for example an authored route hostname template).
 */
export class ConfigExpressionError extends Schema.TaggedError<ConfigExpressionError>()(
  "ConfigExpressionError",
  {
    message: Schema.String,
    expression: Schema.String,
    path: Schema.String,
    filePath: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}
