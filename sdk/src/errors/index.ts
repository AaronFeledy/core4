/** Tagged error exports for the SDK. */
import { Schema } from "effect";

import { FileSyncMode } from "../schema/file-sync.ts";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

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

/**
 * Programmatic `.lando.ts` Landofile violated the loader's sandbox policy
 * (forbidden module import, host shell-out, network fetch, or filesystem
 * access outside the app root).
 */
export class LandofileSandboxError extends Schema.TaggedError<LandofileSandboxError>()(
  "LandofileSandboxError",
  {
    message: Schema.String,
    filePath: Schema.String,
    violation: Schema.String,
    remediation: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Programmatic `.lando.ts` Landofile did not produce a value within the
 * configured execution timeout.
 */
export class LandofileTimeoutError extends Schema.TaggedError<LandofileTimeoutError>()(
  "LandofileTimeoutError",
  {
    message: Schema.String,
    filePath: Schema.String,
    timeoutMs: Schema.Number,
    remediation: Schema.String,
  },
) {}

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

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
  feature: Schema.optional(Schema.String),
  capability: Schema.String,
  providerId: Schema.String,
  remediation: Schema.optional(Schema.String),
}) {}

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

export class RecipeManifestNotFoundError extends Schema.TaggedError<RecipeManifestNotFoundError>()(
  "RecipeManifestNotFoundError",
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

export class RecipeManifestParseError extends Schema.TaggedError<RecipeManifestParseError>()(
  "RecipeManifestParseError",
  {
    message: Schema.String,
    source: Schema.String,
    line: Schema.UndefinedOr(Schema.Number),
    column: Schema.UndefinedOr(Schema.Number),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class RecipeManifestValidationError extends Schema.TaggedError<RecipeManifestValidationError>()(
  "RecipeManifestValidationError",
  {
    message: Schema.String,
    source: Schema.String,
    issues: Schema.Array(Schema.String),
  },
) {}

export class InitTargetExistsError extends Schema.TaggedError<InitTargetExistsError>()(
  "InitTargetExistsError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.String,
  },
) {}

export class RecipeMissingAnswerError extends Schema.TaggedError<RecipeMissingAnswerError>()(
  "RecipeMissingAnswerError",
  {
    message: Schema.String,
    promptName: Schema.String,
    remediation: Schema.String,
  },
) {}

export class RecipePromptValidationError extends Schema.TaggedError<RecipePromptValidationError>()(
  "RecipePromptValidationError",
  {
    message: Schema.String,
    promptName: Schema.String,
    promptType: Schema.String,
    issue: Schema.String,
    remediation: Schema.String,
  },
) {}

export class RecipePostInitError extends Schema.TaggedError<RecipePostInitError>()("RecipePostInitError", {
  message: Schema.String,
  recipe: Schema.String,
  actionIndex: Schema.Number,
  actionType: Schema.String,
  actionVerb: Schema.optional(Schema.String),
  kind: Schema.Literal(
    "outside-destination",
    "missing-package-json",
    "unsupported-action",
    "exit",
    "when-not-supported",
  ),
  remediation: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {}

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

/**
 * ShellScriptOutsideRootError — raised when a host-shell script path
 * resolves outside every permitted base directory. The host `ToolingEngine`
 * (and any other code that loads `.bun.sh` / shell-shaped scripts from
 * the filesystem) MUST refuse paths whose realpath escapes the app root
 * (or the user-config-root recipe cache).
 */
export class ShellScriptOutsideRootError extends Schema.TaggedError<ShellScriptOutsideRootError>()(
  "ShellScriptOutsideRootError",
  {
    message: Schema.String,
    path: Schema.String,
    realpath: Schema.optional(Schema.String),
    permittedRoots: Schema.Array(Schema.String),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * BunShellScriptFrontMatterError — raised when a `.bun.sh` script-backed
 * tooling task has a missing or malformed YAML front-matter
 * block. The front-matter MUST be the first contiguous comment block at
 * the top of the file wrapped in `# ---` markers and uniformly prefixed
 * with `# `; it MUST validate against the `BunShellScriptFrontMatter`
 * schema published from `@lando/sdk`.
 */
export class BunShellScriptFrontMatterError extends Schema.TaggedError<BunShellScriptFrontMatterError>()(
  "BunShellScriptFrontMatterError",
  {
    message: Schema.String,
    path: Schema.String,
    issues: Schema.optional(Schema.Array(Schema.String)),
    remediation: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * BunShellScriptEmptyError — raised when a `.bun.sh` script-backed
 * tooling task is an empty file. Empty scripts cannot be
 * compiled into a task.
 */
export class BunShellScriptEmptyError extends Schema.TaggedError<BunShellScriptEmptyError>()(
  "BunShellScriptEmptyError",
  {
    message: Schema.String,
    path: Schema.String,
    remediation: Schema.optional(Schema.String),
  },
) {}

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

export class GuideFixtureNotFoundError extends Schema.TaggedError<GuideFixtureNotFoundError>()(
  "GuideFixtureNotFoundError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {}

export class GuideFixtureSymlinkError extends Schema.TaggedError<GuideFixtureSymlinkError>()(
  "GuideFixtureSymlinkError",
  {
    message: Schema.String,
    fixtureName: Schema.String,
    path: Schema.String,
  },
) {}

export class GuideFrontmatterValidationError extends Schema.TaggedError<GuideFrontmatterValidationError>()(
  "GuideFrontmatterValidationError",
  {
    message: Schema.String,
    sourcePath: Schema.String,
    field: Schema.String,
    rejectedValue: Schema.Unknown,
    issues: Schema.Array(Schema.String),
    remediation: Schema.String,
  },
) {}

export class GuideHiddenScenarioReasonError extends Schema.TaggedError<GuideHiddenScenarioReasonError>()(
  "GuideHiddenScenarioReasonError",
  {
    message: Schema.String,
    commandId: Schema.String,
    specSection: Schema.String,
    sourcePath: Schema.String,
    scenarioId: Schema.String,
    rejectedValue: Schema.Unknown,
    remediation: Schema.String,
  },
) {}

export class EventError extends Schema.TaggedError<EventError>()("EventError", {
  message: Schema.String,
  event: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
  message: Schema.String,
  key: Schema.optional(Schema.String),
  decodeError: Schema.optional(Schema.Unknown),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

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

export class LandoRuntimeBootstrapError extends Schema.TaggedError<LandoRuntimeBootstrapError>()(
  "LandoRuntimeBootstrapError",
  {
    message: Schema.String,
    stage: Schema.Literal("minimal", "plugins", "commands", "provider", "app", "tooling"),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

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

/**
 * RendererSelectionError — raised before command execution when a
 * renderer value is supplied that is not supported by the current CLI
 * configuration.
 */
export class RendererSelectionError extends Schema.TaggedError<RendererSelectionError>()(
  "RendererSelectionError",
  {
    message: Schema.String,
    value: Schema.String,
    source: Schema.Literal("flag", "env", "config"),
    remediation: Schema.String,
  },
) {}

/**
 * FileSyncStartError — emitted when `FileSyncEngine.createSession`, `setup`,
 * or `isAvailable` fails. Typical causes include a missing binary, an
 * unreachable daemon, a refused agent deploy, a missing capability,
 * source paths outside the app root, or a target path conflict. Payload
 * includes the engine id, the rejected `FileSyncSessionSpec` shape when
 * applicable (kept as `Unknown` for publishing redaction), a remediation
 * pointer, and a debug `cause`.
 */
export class FileSyncStartError extends Schema.TaggedError<FileSyncStartError>()("FileSyncStartError", {
  engineId: Schema.String,
  message: Schema.String,
  sessionSpec: Schema.optional(Schema.Unknown),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * FileSyncDriftError — emitted when `FileSyncEngine.streamEvents` or a
 * running session surfaces content drift or a conflict that cannot be
 * reconciled automatically under the requested sync mode. Payload
 * includes the `FileSyncSessionRef` as a string, the conflicted paths
 * (relative to the session source after publishing-layer redaction), an
 * optional suggested mode upgrade, and a debug `cause`.
 */
export class FileSyncDriftError extends Schema.TaggedError<FileSyncDriftError>()("FileSyncDriftError", {
  engineId: Schema.String,
  message: Schema.String,
  sessionRef: Schema.String,
  conflictedPaths: Schema.Array(Schema.String),
  suggestedMode: Schema.optional(FileSyncMode),
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * FileSyncStopError — `FileSyncEngine.terminateSession` or
 * `pauseSession`/`resumeSession` finalisation failed. Payload includes the
 * engine id, the `FileSyncSessionRef` as a string, a remediation pointer
 * (usually `lando apps poweroff` for daemon clean-up), and a debug
 * `cause`.
 */
export class FileSyncStopError extends Schema.TaggedError<FileSyncStopError>()("FileSyncStopError", {
  engineId: Schema.String,
  sessionRef: Schema.String,
  message: Schema.String,
  remediation: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}
