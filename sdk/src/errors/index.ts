/**
 * Tagged-error catalog.
 *
 * Tagged errors only — no thrown exceptions in core. `Schema.TaggedError`
 * plugs into Effect's error channel. Provider errors carry required fields
 * (providerId, operation, message, details, remediation, cause).
 *
 * Every public failure surface is a discriminated `Schema.TaggedError`
 * subclass with a stable `_tag` and a human-readable `message`. Plugins
 * extend this catalog with their own tagged errors; core only defines the
 * ones it raises itself.
 */
import { Schema } from "effect";

// -- Config ----------------------------------------------------------------
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Landofile -------------------------------------------------------------
export class LandofileNotFoundError extends Schema.TaggedError<LandofileNotFoundError>()(
  "LandofileNotFoundError",
  {
    message: Schema.String,
    cwd: Schema.String,
  },
) {}

export class LandofileParseError extends Schema.TaggedError<LandofileParseError>()("LandofileParseError", {
  message: Schema.String,
  filePath: Schema.String,
  line: Schema.UndefinedOr(Schema.Number),
  column: Schema.UndefinedOr(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class LandofileValidationError extends Schema.TaggedError<LandofileValidationError>()(
  "LandofileValidationError",
  {
    message: Schema.String,
    file: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}

// -- Plugins ---------------------------------------------------------------
export class PluginLoadError extends Schema.TaggedError<PluginLoadError>()("PluginLoadError", {
  message: Schema.String,
  pluginName: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()("PluginManifestError", {
  message: Schema.String,
  pluginName: Schema.optional(Schema.String),
  issues: Schema.Array(Schema.String),
}) {}

// -- Providers ------------------------------------------------------------
const ProviderErrorBase = {
  providerId: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
};

export class ProviderUnavailableError extends Schema.TaggedError<ProviderUnavailableError>()(
  "ProviderUnavailableError",
  ProviderErrorBase,
) {}

export class ProviderCapabilityError extends Schema.TaggedError<ProviderCapabilityError>()(
  "ProviderCapabilityError",
  {
    ...ProviderErrorBase,
    capability: Schema.String,
    requiredValue: Schema.Unknown,
    actualValue: Schema.Unknown,
  },
) {}

export class ProviderConfigError extends Schema.TaggedError<ProviderConfigError>()(
  "ProviderConfigError",
  ProviderErrorBase,
) {}

export class ProviderInternalError extends Schema.TaggedError<ProviderInternalError>()(
  "ProviderInternalError",
  ProviderErrorBase,
) {}

export class ArtifactBuildError extends Schema.TaggedError<ArtifactBuildError>()(
  "ArtifactBuildError",
  ProviderErrorBase,
) {}

export class ServiceStartError extends Schema.TaggedError<ServiceStartError>()("ServiceStartError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class ServiceExecError extends Schema.TaggedError<ServiceExecError>()("ServiceExecError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class ServiceNotFoundError extends Schema.TaggedError<ServiceNotFoundError>()("ServiceNotFoundError", {
  ...ProviderErrorBase,
  service: Schema.String,
}) {}

export class NoProviderInstalledError extends Schema.TaggedError<NoProviderInstalledError>()(
  "NoProviderInstalledError",
  {
    message: Schema.String,
    suggestion: Schema.optional(Schema.String),
  },
) {}

// -- Capabilities ----------------------------------------------------------
export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
  feature: Schema.optional(Schema.String),
  capability: Schema.String,
  providerId: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}

// -- Recipes ---------------------------------------------------------------
export class RecipeError extends Schema.TaggedError<RecipeError>()("RecipeError", {
  message: Schema.String,
  recipe: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class RecipeMissingPluginError extends Schema.TaggedError<RecipeMissingPluginError>()(
  "RecipeMissingPluginError",
  {
    message: Schema.String,
    recipe: Schema.String,
    missing: Schema.Array(Schema.String),
  },
) {}

// -- Init ------------------------------------------------------------------
export class InitTargetExistsError extends Schema.TaggedError<InitTargetExistsError>()(
  "InitTargetExistsError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.String,
  },
) {}

// -- Service planning ------------------------------------------------------
export class ServiceTypeError extends Schema.TaggedError<ServiceTypeError>()("ServiceTypeError", {
  message: Schema.String,
  serviceType: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ServiceFeatureError extends Schema.TaggedError<ServiceFeatureError>()("ServiceFeatureError", {
  message: Schema.String,
  feature: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Tooling ---------------------------------------------------------------
export class ToolingCompileError extends Schema.TaggedError<ToolingCompileError>()("ToolingCompileError", {
  message: Schema.String,
  tool: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ToolingExecError extends Schema.TaggedError<ToolingExecError>()("ToolingExecError", {
  message: Schema.String,
  tool: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ShellExecError extends Schema.TaggedError<ShellExecError>()("ShellExecError", {
  message: Schema.String,
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProcessExecError extends Schema.TaggedError<ProcessExecError>()("ProcessExecError", {
  message: Schema.String,
  cmd: Schema.String,
  cwd: Schema.optional(Schema.String),
  errno: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()("ProcessTimeoutError", {
  message: Schema.String,
  cmd: Schema.String,
  cwd: Schema.optional(Schema.String),
  elapsedMs: Schema.Number,
}) {}

// -- Filesystem ------------------------------------------------------------
export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FilePermissionError extends Schema.TaggedError<FilePermissionError>()("FilePermissionError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class FileIoError extends Schema.TaggedError<FileIoError>()("FileIoError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Lifecycle / events ----------------------------------------------------
export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  message: Schema.String,
  event: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Cache -----------------------------------------------------------------
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
  decodeError: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Subsystems (proxy, certs, etc.) --------------------------------------
export class ProxyError extends Schema.TaggedError<ProxyError>()("ProxyError", {
  message: Schema.String,
  proxyId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CaError extends Schema.TaggedError<CaError>()("CaError", {
  message: Schema.String,
  caId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// -- Runtime / bootstrap --------------------------------------------------
export class LandoRuntimeBootstrapError extends Schema.TaggedError<LandoRuntimeBootstrapError>()(
  "LandoRuntimeBootstrapError",
  {
    message: Schema.String,
    stage: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// -- CLI commands ----------------------------------------------------------
export class LandoCommandError extends Schema.TaggedError<LandoCommandError>()("LandoCommandError", {
  message: Schema.String,
  commandId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class NotImplementedError extends Schema.TaggedError<NotImplementedError>()("NotImplementedError", {
  message: Schema.String,
  commandId: Schema.String,
  specSection: Schema.String,
  remediation: Schema.String,
}) {}
